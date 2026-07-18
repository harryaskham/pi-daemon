import { createHash } from "node:crypto";
import { lstat, open, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TextDecoder } from "node:util";

import type { FileEntry, SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  DASH_DEFAULT_LIMITS,
  asDashboardCursor,
  asDashboardFingerprint,
  type DashboardCursor,
  type DashboardFingerprint,
  type NormalizedTranscriptRecord,
  type TranscriptContentBlock,
  type TranscriptMessageRecord,
  type TranscriptPage,
  type TranscriptQuery,
  type TranscriptTimelineRecord,
  type TranscriptToolRecord,
} from "./dashboard-contract.js";
import {
  atomicWritePrivateJson,
  ensurePrivateDirectory,
  readPrivateJsonIfExists,
  stateFileSize,
} from "./durability.js";
import type { JsonObject, JsonValue } from "./session-api.js";
import { formatSessionSourceFingerprint } from "./source-fingerprint.js";

const PROJECTION_CACHE_FORMAT_VERSION = 1 as const;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const DEFAULT_TEXT_BLOCK_BYTES = 256 * 1024;

export interface TranscriptProjectionLimits {
  maxSourceBytes: number;
  maxLineBytes: number;
  maxEntries: number;
  maxOutputBytes: number;
  maxRecordBytes: number;
  maxPageRecords: number;
  maxCacheEntries: number;
  maxCacheBytes: number;
  maxCacheEntryBytes: number;
  cacheMaxAgeMs: number;
  maxImagePreviewBytes: number;
}

export interface TranscriptProjectionRequest {
  inventoryId: string;
  path: string;
  query?: TranscriptQuery;
  /** Opaque inventory fingerprint. It is revalidated against source metadata. */
  expectedFingerprint?: DashboardFingerprint;
}

interface ProjectionCacheRecord {
  formatVersion: typeof PROJECTION_CACHE_FORMAT_VERSION;
  inventoryId: string;
  sourceFingerprint: string;
  sourceSizeBytes: number;
  sourceModifiedMs: number;
  builtAt: string;
  currentLeafId?: string;
  piSessionId?: string;
  records: NormalizedTranscriptRecord[];
  truncated: boolean;
}

interface ParsedSession {
  entries: FileEntry[];
  fingerprint: DashboardFingerprint;
  sourceSizeBytes: number;
  sourceModifiedMs: number;
}

interface ProjectedSession {
  currentLeafId?: string;
  piSessionId?: string;
  records: NormalizedTranscriptRecord[];
  truncated: boolean;
}

export class TranscriptProjectionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "TranscriptProjectionError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Bounded preview-only projection of Pi JSONL trees.
 *
 * This class does not construct SessionManager/AgentSessionRuntime, load auth,
 * extensions or models, and has no prompt-capable dependency.
 */
export class TranscriptProjector {
  readonly cacheDir: string;
  readonly limits: TranscriptProjectionLimits;
  readonly #now: () => Date;
  readonly #builds = new Map<string, Promise<ProjectionCacheRecord>>();

  constructor(options: {
    stateDir: string;
    limits?: Partial<TranscriptProjectionLimits>;
    now?: () => Date;
  }) {
    if (options.stateDir.length === 0) throw new Error("stateDir must not be empty");
    this.cacheDir = join(resolve(options.stateDir), "web", "projections");
    this.limits = projectionLimits(options.limits);
    this.#now = options.now ?? (() => new Date());
  }

  async project(request: TranscriptProjectionRequest): Promise<TranscriptPage> {
    validateInventoryId(request.inventoryId);
    const path = resolve(request.path);
    const source = await inspectSource(path, this.limits.maxSourceBytes);
    const cachePath = this.#cachePath(request.inventoryId);
    const cached = await this.#readCache(cachePath);
    const expected = request.expectedFingerprint;
    const cacheMatches =
      cached !== undefined &&
      cached.inventoryId === request.inventoryId &&
      cached.sourceSizeBytes === source.size &&
      cached.sourceModifiedMs === source.mtimeMs &&
      this.#now().getTime() - Date.parse(cached.builtAt) <= this.limits.cacheMaxAgeMs &&
      (expected === undefined || cached.sourceFingerprint === expected);
    const projection = cacheMatches
      ? cached
      : await this.#buildOnce(request.inventoryId, path, expected, cachePath);
    return pageFromProjection(request.inventoryId, projection, request.query, this.limits, cacheMatches);
  }

  async clear(inventoryId?: string): Promise<void> {
    if (inventoryId === undefined) {
      await rm(this.cacheDir, { recursive: true, force: true });
      return;
    }
    validateInventoryId(inventoryId);
    await rm(this.#cachePath(inventoryId), { force: true });
  }

  async #buildOnce(
    inventoryId: string,
    path: string,
    expectedFingerprint: DashboardFingerprint | undefined,
    cachePath: string,
  ): Promise<ProjectionCacheRecord> {
    const key = `${inventoryId}\u0000${expectedFingerprint ?? ""}\u0000${path}`;
    const existing = this.#builds.get(key);
    if (existing !== undefined) return existing;
    const build = this.#build(inventoryId, path, expectedFingerprint, cachePath);
    this.#builds.set(key, build);
    try {
      return await build;
    } finally {
      if (this.#builds.get(key) === build) this.#builds.delete(key);
    }
  }

  async #build(
    inventoryId: string,
    path: string,
    expectedFingerprint: DashboardFingerprint | undefined,
    cachePath: string,
  ): Promise<ProjectionCacheRecord> {
    const parsed = await parseSessionFile(path, this.limits);
    if (expectedFingerprint !== undefined && parsed.fingerprint !== expectedFingerprint) {
      throw new TranscriptProjectionError(
        "source_fingerprint_changed",
        "session source changed since inventory",
        true,
      );
    }
    const projected = await projectSession(
      parsed.entries,
      inventoryId,
      parsed.fingerprint,
      this.limits,
    );
    const record: ProjectionCacheRecord = {
      formatVersion: PROJECTION_CACHE_FORMAT_VERSION,
      inventoryId,
      sourceFingerprint: expectedFingerprint ?? parsed.fingerprint,
      sourceSizeBytes: parsed.sourceSizeBytes,
      sourceModifiedMs: parsed.sourceModifiedMs,
      builtAt: this.#now().toISOString(),
      records: projected.records,
      truncated: projected.truncated,
      ...(projected.currentLeafId === undefined
        ? {}
        : { currentLeafId: projected.currentLeafId }),
      ...(projected.piSessionId === undefined ? {} : { piSessionId: projected.piSessionId }),
    };
    const bytes = jsonBytes(record);
    if (bytes <= this.limits.maxCacheEntryBytes) {
      await ensurePrivateDirectory(this.cacheDir, "transcript projection cache");
      await atomicWritePrivateJson(cachePath, record);
      await this.#pruneCache(cachePath);
    }
    return record;
  }

  async #readCache(path: string): Promise<ProjectionCacheRecord | undefined> {
    const bytes = await stateFileSize(path);
    if (bytes === undefined) return undefined;
    if (bytes > this.limits.maxCacheEntryBytes) {
      await rm(path, { force: true });
      return undefined;
    }
    try {
      const value = await readPrivateJsonIfExists<unknown>(path);
      return isProjectionCacheRecord(value, this.limits) ? value : undefined;
    } catch {
      await rm(path, { force: true });
      return undefined;
    }
  }

  async #pruneCache(preservePath: string): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(this.cacheDir)).filter((name) => name.endsWith(".json"));
    } catch {
      return;
    }
    const now = this.#now().getTime();
    const files = (
      await Promise.all(
        names.map(async (name) => {
          const path = join(this.cacheDir, name);
          try {
            const info = await stat(path);
            return { path, bytes: info.size, modifiedMs: info.mtimeMs };
          } catch {
            return undefined;
          }
        }),
      )
    )
      .filter((entry): entry is { path: string; bytes: number; modifiedMs: number } => entry !== undefined)
      .sort((left, right) => right.modifiedMs - left.modifiedMs);
    let retained = 0;
    let bytes = 0;
    for (const file of files) {
      const expired = now - file.modifiedMs > this.limits.cacheMaxAgeMs;
      const overCount = retained >= this.limits.maxCacheEntries;
      const overBytes = bytes + file.bytes > this.limits.maxCacheBytes;
      if (file.path !== preservePath && (expired || overCount || overBytes)) {
        await rm(file.path, { force: true });
        continue;
      }
      retained += 1;
      bytes += file.bytes;
    }
  }

  #cachePath(inventoryId: string): string {
    const digest = createHash("sha256").update(inventoryId).digest("hex");
    return join(this.cacheDir, `${digest}.json`);
  }
}

async function parseSessionFile(
  path: string,
  limits: TranscriptProjectionLimits,
): Promise<ParsedSession> {
  const before = await inspectSource(path, limits.maxSourceBytes);
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  const entries: unknown[] = [];
  let lineParts: Buffer[] = [];
  let lineBytes = 0;
  let offset = 0;
  try {
    const opened = await handle.stat();
    validateOpenedSource(opened, limits.maxSourceBytes);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new TranscriptProjectionError("source_changed", "session source changed before read", true);
    }
    const chunk = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > limits.maxSourceBytes) {
        throw new TranscriptProjectionError("source_too_large", "session source exceeds its byte limit");
      }
      const bytes = Buffer.from(chunk.subarray(0, bytesRead));
      hash.update(bytes);
      let start = 0;
      while (start < bytes.length) {
        const newline = bytes.indexOf(0x0a, start);
        const end = newline === -1 ? bytes.length : newline;
        const part = bytes.subarray(start, end);
        lineBytes += part.length;
        if (lineBytes > limits.maxLineBytes) {
          throw new TranscriptProjectionError("line_too_large", "session line exceeds its byte limit");
        }
        if (part.length > 0) lineParts.push(part);
        if (newline === -1) break;
        appendParsedLine(entries, lineParts, lineBytes, limits.maxEntries);
        lineParts = [];
        lineBytes = 0;
        start = newline + 1;
      }
    }
    if (lineBytes > 0 || lineParts.length > 0) {
      appendParsedLine(entries, lineParts, lineBytes, limits.maxEntries);
    }
    const after = await handle.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new TranscriptProjectionError("source_changed", "session source changed during read", true);
    }
  } finally {
    await handle.close();
  }
  if (entries.length === 0 || !isRecord(entries[0]) || entries[0].type !== "session") {
    throw new TranscriptProjectionError("invalid_session", "session source is missing its header");
  }
  const migrated = await migrateProjectionEntries(entries);
  return {
    entries: migrated,
    fingerprint: formatSessionSourceFingerprint(hash.digest()),
    sourceSizeBytes: before.size,
    sourceModifiedMs: before.mtimeMs,
  };
}

function appendParsedLine(
  entries: unknown[],
  parts: Buffer[],
  bytes: number,
  maxEntries: number,
): void {
  if (bytes === 0) return;
  const line = Buffer.concat(parts, bytes);
  const content = line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line;
  let text: string;
  try {
    text = UTF8.decode(content);
  } catch {
    throw new TranscriptProjectionError("invalid_utf8", "session source contains invalid UTF-8");
  }
  if (text.trim().length === 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new TranscriptProjectionError("invalid_json", "session source contains invalid JSONL");
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    throw new TranscriptProjectionError("invalid_entry", "session line is not a typed object");
  }
  entries.push(parsed);
  if (entries.length > maxEntries + 1) {
    throw new TranscriptProjectionError("too_many_entries", "session exceeds its entry limit");
  }
}

async function migrateProjectionEntries(entries: unknown[]): Promise<FileEntry[]> {
  const cloned = structuredClone(entries) as Array<Record<string, unknown>>;
  const header = cloned[0];
  if (header?.type !== "session") {
    throw new TranscriptProjectionError("invalid_session", "session source is missing its header");
  }
  const version = typeof header.version === "number" ? header.version : 1;
  if (!Number.isInteger(version) || version < 1 || version > 3) {
    throw new TranscriptProjectionError("unsupported_session_version", "session version is unsupported");
  }
  if (typeof header.id !== "string" || typeof header.cwd !== "string") {
    throw new TranscriptProjectionError("invalid_session", "session header identity is invalid");
  }
  if (version < 2) {
    let parentId: string | null = null;
    for (let index = 1; index < cloned.length; index += 1) {
      if (index % 1024 === 0) await yieldToEventLoop();
      const entry = cloned[index]!;
      const digest = createHash("sha256")
        .update(String(index))
        .update("\u0000")
        .update(JSON.stringify(entry))
        .digest("hex")
        .slice(0, 16);
      const id = `legacy-${digest}`;
      entry.id = id;
      entry.parentId = parentId;
      parentId = id;
    }
    for (const entry of cloned) {
      if (entry.type !== "compaction" || typeof entry.firstKeptEntryIndex !== "number") continue;
      const kept = cloned[entry.firstKeptEntryIndex];
      if (kept !== undefined && kept.type !== "session" && typeof kept.id === "string") {
        entry.firstKeptEntryId = kept.id;
      }
      delete entry.firstKeptEntryIndex;
    }
  }
  if (version < 3) {
    for (const entry of cloned) {
      if (entry.type !== "message" || !isRecord(entry.message)) continue;
      if (entry.message.role === "hookMessage") entry.message.role = "custom";
    }
  }
  header.version = 3;
  await validateEntryTree(cloned);
  return cloned as unknown as FileEntry[];
}

async function validateEntryTree(entries: Array<Record<string, unknown>>): Promise<void> {
  const ids = new Set<string>();
  for (let index = 1; index < entries.length; index += 1) {
    if (index % 2048 === 0) await yieldToEventLoop();
    const entry = entries[index]!;
    if (typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > 256) {
      throw new TranscriptProjectionError("invalid_entry", "session entry ID is invalid");
    }
    if (ids.has(entry.id)) {
      throw new TranscriptProjectionError("duplicate_entry", "session contains duplicate entry IDs");
    }
    if (entry.parentId !== null && typeof entry.parentId !== "string") {
      throw new TranscriptProjectionError("invalid_entry", "session parent entry ID is invalid");
    }
    ids.add(entry.id);
  }
}

async function projectSession(
  fileEntries: FileEntry[],
  inventoryId: string,
  fingerprint: DashboardFingerprint,
  limits: TranscriptProjectionLimits,
): Promise<ProjectedSession> {
  const header = fileEntries[0];
  const entries = fileEntries.slice(1) as SessionEntry[];
  const leaf = entries.at(-1);
  const branchResult = await activeBranch(entries, leaf?.id);
  const branch = branchResult.entries;
  const toolResults = new Map<string, SessionEntry>();
  const mergedToolCallIds = new Set<string>();
  for (const [index, entry] of branch.entries()) {
    if (index % 2048 === 0) await yieldToEventLoop();
    if (entry.type !== "message") continue;
    if (entry.message.role === "toolResult") {
      if (toolResults.has(entry.message.toolCallId)) {
        throw new TranscriptProjectionError(
          "duplicate_tool_result",
          "session contains duplicate tool result identities",
        );
      }
      toolResults.set(entry.message.toolCallId, entry);
      continue;
    }
    if (entry.message.role !== "assistant") continue;
    for (const block of entry.message.content) {
      if (block.type !== "toolCall") continue;
      if (mergedToolCallIds.has(block.id)) {
        throw new TranscriptProjectionError(
          "duplicate_tool_call",
          "session contains duplicate tool call identities",
        );
      }
      mergedToolCallIds.add(block.id);
    }
  }

  const records: NormalizedTranscriptRecord[] = [];
  for (const [index, entry] of branch.entries()) {
    if (index % 512 === 0) await yieldToEventLoop();
    const projected = projectEntry(
      entry,
      inventoryId,
      fingerprint,
      toolResults,
      mergedToolCallIds,
      limits,
    );
    records.push(...projected);
  }
  const bounded = boundProjectionRecords(records, limits);
  return {
    records: bounded.records,
    truncated: branchResult.truncated || bounded.truncated,
    ...(leaf === undefined ? {} : { currentLeafId: leaf.id }),
    ...(header?.type === "session" && typeof header.id === "string"
      ? { piSessionId: header.id }
      : {}),
  };
}

async function activeBranch(
  entries: SessionEntry[],
  leafId: string | undefined,
): Promise<{ entries: SessionEntry[]; truncated: boolean }> {
  if (leafId === undefined) return { entries: [], truncated: false };
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const reversed: SessionEntry[] = [];
  const visited = new Set<string>();
  let current: string | null = leafId;
  let truncated = false;
  while (current !== null) {
    if (visited.size > 0 && visited.size % 2048 === 0) await yieldToEventLoop();
    if (visited.has(current)) {
      truncated = true;
      break;
    }
    visited.add(current);
    const entry = byId.get(current);
    if (entry === undefined) {
      truncated = true;
      break;
    }
    reversed.push(entry);
    current = entry.parentId;
  }
  reversed.reverse();
  return { entries: reversed, truncated };
}

function projectEntry(
  entry: SessionEntry,
  inventoryId: string,
  fingerprint: DashboardFingerprint,
  toolResults: Map<string, SessionEntry>,
  mergedToolCallIds: Set<string>,
  limits: TranscriptProjectionLimits,
): NormalizedTranscriptRecord[] {
  switch (entry.type) {
    case "message":
      return projectMessageEntry(
        entry,
        inventoryId,
        fingerprint,
        toolResults,
        mergedToolCallIds,
        limits,
      );
    case "compaction":
      return [
        {
          recordId: `summary:${entry.id}`,
          key: { entryId: entry.id },
          kind: "summary",
          summaryKind: "compaction",
          source: "persisted",
          timestamp: entry.timestamp,
          ...(entry.parentId === null ? {} : { parentEntryId: entry.parentId }),
          content: [{ type: "markdown", text: boundedText(entry.summary) }],
        },
      ];
    case "branch_summary":
      return [
        {
          recordId: `summary:${entry.id}`,
          key: { entryId: entry.id },
          kind: "summary",
          summaryKind: "branch",
          source: "persisted",
          timestamp: entry.timestamp,
          ...(entry.parentId === null ? {} : { parentEntryId: entry.parentId }),
          content: [{ type: "markdown", text: boundedText(entry.summary) }],
        },
      ];
    case "custom_message":
      return [
        {
          recordId: `custom:${entry.id}`,
          key: { entryId: entry.id },
          kind: "custom",
          customType: entry.customType,
          hidden: !entry.display,
          source: "persisted",
          timestamp: entry.timestamp,
          ...(entry.parentId === null ? {} : { parentEntryId: entry.parentId }),
          ...(!entry.display
            ? {}
            : { fallbackText: contentText(entry.content, DEFAULT_TEXT_BLOCK_BYTES) }),
          ...(entry.display && entry.details !== undefined
            ? { data: boundedJson(entry.details, limits.maxRecordBytes / 2) }
            : {}),
        },
      ];
    case "custom":
      return [
        {
          recordId: `custom:${entry.id}`,
          key: { entryId: entry.id },
          kind: "custom",
          customType: entry.customType,
          hidden: false,
          source: "persisted",
          timestamp: entry.timestamp,
          ...(entry.parentId === null ? {} : { parentEntryId: entry.parentId }),
          ...(entry.data === undefined
            ? {}
            : { data: boundedJson(entry.data, limits.maxRecordBytes / 2) }),
        },
      ];
    case "model_change":
      return [timeline(entry, "model", `${entry.provider}/${entry.modelId}`, {
        provider: entry.provider,
        modelId: entry.modelId,
      })];
    case "thinking_level_change":
      return [timeline(entry, "thinking", entry.thinkingLevel, { level: entry.thinkingLevel })];
    case "session_info":
      return [timeline(entry, "session-name", entry.name, entry.name === undefined ? {} : { name: entry.name })];
    case "label":
      return [
        timeline(entry, "label", entry.label, {
          targetId: entry.targetId,
          ...(entry.label === undefined ? {} : { label: entry.label }),
        }),
      ];
  }
}

function projectMessageEntry(
  entry: Extract<SessionEntry, { type: "message" }>,
  inventoryId: string,
  fingerprint: DashboardFingerprint,
  toolResults: Map<string, SessionEntry>,
  mergedToolCallIds: Set<string>,
  limits: TranscriptProjectionLimits,
): NormalizedTranscriptRecord[] {
  const message = entry.message as unknown as Record<string, unknown>;
  const role = message.role;
  if (role === "assistant") {
    const records: NormalizedTranscriptRecord[] = [];
    const content = Array.isArray(message.content) ? message.content : [];
    const blocks: TranscriptContentBlock[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        blocks.push({ type: "markdown", text: boundedText(block.text) });
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        blocks.push({ type: "thinking", text: boundedText(block.thinking) });
      }
    }
    if (typeof message.errorMessage === "string") {
      blocks.push({ type: "error", text: boundedText(message.errorMessage) });
    }
    const usage = usageBlock(message.usage);
    if (usage !== undefined) blocks.push(usage);
    if (blocks.length > 0) {
      records.push(messageRecord(entry, "assistant", blocks, message.stopReason === "error" ? "error" : "complete"));
    }
    for (const block of content) {
      if (!isRecord(block) || block.type !== "toolCall") continue;
      if (typeof block.id !== "string" || typeof block.name !== "string") continue;
      const resultEntry = toolResults.get(block.id);
      const resultMessage =
        resultEntry?.type === "message" && resultEntry.message.role === "toolResult"
          ? (resultEntry.message as unknown as Record<string, unknown>)
          : undefined;
      const resultContent = resultMessage === undefined
        ? []
        : contentBlocks(
            resultMessage.content,
            inventoryId,
            fingerprint,
            resultEntry!.id,
            limits,
          );
      const tool: TranscriptToolRecord = {
        recordId: `tool:${block.id}`,
        key: { entryId: entry.id, toolCallId: block.id },
        kind: "tool",
        toolName: block.name,
        state:
          resultMessage === undefined
            ? "pending"
            : resultMessage.isError === true
              ? "error"
              : "success",
        source: "persisted",
        timestamp: entry.timestamp,
        ...(entry.parentId === null ? {} : { parentEntryId: entry.parentId }),
        content: resultContent,
        ...(isRecord(block.arguments)
          ? { arguments: boundedJson(block.arguments, limits.maxRecordBytes / 3) as JsonObject }
          : {}),
        ...(resultMessage?.details === undefined
          ? {}
          : { details: boundedJson(resultMessage.details, limits.maxRecordBytes / 3) }),
      };
      records.push(tool);
    }
    return records;
  }
  if (role === "toolResult") {
    if (
      typeof message.toolCallId === "string" &&
      mergedToolCallIds.has(message.toolCallId) &&
      toolResults.get(message.toolCallId) === entry
    ) {
      return [];
    }
    if (typeof message.toolCallId !== "string") return [];
    return [
      {
        recordId: `tool:${message.toolCallId}`,
        key: { entryId: entry.id, toolCallId: message.toolCallId },
        kind: "tool",
        toolName: typeof message.toolName === "string" ? message.toolName : "unknown",
        state: message.isError === true ? "error" : "success",
        source: "persisted",
        timestamp: entry.timestamp,
        ...(entry.parentId === null ? {} : { parentEntryId: entry.parentId }),
        content: contentBlocks(message.content, inventoryId, fingerprint, entry.id, limits),
        ...(message.details === undefined
          ? {}
          : { details: boundedJson(message.details, limits.maxRecordBytes / 3) }),
      },
    ];
  }
  if (role === "bashExecution") {
    const data = boundedJson(
      {
        command: typeof message.command === "string" ? boundedText(message.command) : "",
        output: typeof message.output === "string" ? boundedText(message.output) : "",
        ...(typeof message.exitCode === "number" ? { exitCode: message.exitCode } : {}),
        cancelled: message.cancelled === true,
        truncated: message.truncated === true,
        excludeFromContext: message.excludeFromContext === true,
      },
      limits.maxRecordBytes / 2,
    ) as JsonObject;
    return [timeline(entry, "bash", typeof message.command === "string" ? boundedText(message.command, 4096) : undefined, data)];
  }
  const normalizedRole = role === "user" || role === "system" || role === "custom" ? role : "custom";
  return [
    messageRecord(
      entry,
      normalizedRole,
      contentBlocks(message.content, inventoryId, fingerprint, entry.id, limits),
      "complete",
    ),
  ];
}

function messageRecord(
  entry: Extract<SessionEntry, { type: "message" }>,
  role: TranscriptMessageRecord["role"],
  content: TranscriptContentBlock[],
  state: TranscriptMessageRecord["state"],
): TranscriptMessageRecord {
  return {
    recordId: `entry:${entry.id}`,
    key: { entryId: entry.id },
    kind: "message",
    role,
    state,
    content,
    source: "persisted",
    timestamp: entry.timestamp,
    ...(entry.parentId === null ? {} : { parentEntryId: entry.parentId }),
  };
}

function timeline(
  entry: SessionEntry,
  event: TranscriptTimelineRecord["event"],
  label: string | undefined,
  data: JsonObject,
): TranscriptTimelineRecord {
  return {
    recordId: `timeline:${entry.id}`,
    key: { entryId: entry.id },
    kind: "timeline",
    event,
    source: "persisted",
    timestamp: entry.timestamp,
    ...(entry.parentId === null ? {} : { parentEntryId: entry.parentId }),
    ...(label === undefined ? {} : { label: boundedText(label, 4096) }),
    ...(Object.keys(data).length === 0 ? {} : { data }),
  };
}

function contentBlocks(
  content: unknown,
  inventoryId: string,
  fingerprint: DashboardFingerprint,
  entryId: string,
  limits: TranscriptProjectionLimits,
): TranscriptContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: boundedText(content) }];
  if (!Array.isArray(content)) return [];
  const blocks: TranscriptContentBlock[] = [];
  for (const [index, block] of content.entries()) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: boundedText(block.text) });
      continue;
    }
    if (block.type !== "image") continue;
    const source = isRecord(block.source) ? block.source : undefined;
    const mediaType =
      typeof block.mimeType === "string"
        ? block.mimeType
        : typeof source?.mediaType === "string"
          ? source.mediaType
          : "application/octet-stream";
    const data =
      typeof block.data === "string"
        ? block.data
        : typeof source?.data === "string"
          ? source.data
          : undefined;
    const estimatedBytes = data === undefined ? 0 : Math.floor((data.length * 3) / 4);
    const blobDigest = createHash("sha256")
      .update(inventoryId)
      .update("\u0000")
      .update(fingerprint)
      .update("\u0000")
      .update(entryId)
      .update("\u0000")
      .update(String(index))
      .digest("base64url");
    blocks.push({
      type: "image",
      mediaType: boundedText(mediaType, 128),
      blobRef: `dash-blob:${blobDigest}`,
      alt:
        estimatedBytes > limits.maxImagePreviewBytes
          ? `Image (${estimatedBytes} bytes; preview deferred)`
          : "Session image",
    });
  }
  return blocks;
}

function usageBlock(value: unknown): TranscriptContentBlock | undefined {
  if (!isRecord(value)) return undefined;
  const cost = isRecord(value.cost) ? value.cost : undefined;
  const block: Extract<TranscriptContentBlock, { type: "usage" }> = { type: "usage" };
  const input = nonNegative(value.input);
  const output = nonNegative(value.output);
  const cacheRead = nonNegative(value.cacheRead);
  const cacheWrite = nonNegative(value.cacheWrite);
  const totalCost = nonNegative(cost?.total);
  if (input !== undefined) block.inputTokens = input;
  if (output !== undefined) block.outputTokens = output;
  if (cacheRead !== undefined) block.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) block.cacheWriteTokens = cacheWrite;
  if (totalCost !== undefined) block.cost = totalCost;
  return Object.keys(block).length === 1 ? undefined : block;
}

function boundProjectionRecords(
  source: NormalizedTranscriptRecord[],
  limits: TranscriptProjectionLimits,
): { records: NormalizedTranscriptRecord[]; truncated: boolean } {
  const records: NormalizedTranscriptRecord[] = [];
  let outputBytes = 2;
  let truncated = false;
  for (const record of source) {
    let candidate = record;
    let bytes = jsonBytes(candidate);
    if (bytes > limits.maxRecordBytes) {
      candidate = truncateRecord(record, limits.maxRecordBytes);
      bytes = jsonBytes(candidate);
      truncated = true;
    }
    if (bytes > limits.maxRecordBytes) {
      truncated = true;
      continue;
    }
    records.push(candidate);
    outputBytes += bytes + 1;
  }
  while (outputBytes > limits.maxOutputBytes && records.length > 0) {
    const removed = records.shift()!;
    outputBytes -= jsonBytes(removed) + 1;
    truncated = true;
  }
  return { records, truncated };
}

function truncateRecord(
  record: NormalizedTranscriptRecord,
  maxBytes: number,
): NormalizedTranscriptRecord {
  const blockLimit = Math.max(256, Math.floor(maxBytes / 8));
  if (record.kind === "message" || record.kind === "summary" || record.kind === "tool") {
    return {
      ...record,
      content: record.content.map((block) =>
        "text" in block ? { ...block, text: boundedText(block.text, blockLimit) } : block,
      ),
      ...(record.kind === "tool" && record.details !== undefined
        ? { details: { truncated: true } }
        : {}),
    };
  }
  if (record.kind === "custom") {
    return {
      ...record,
      ...(record.fallbackText === undefined
        ? {}
        : { fallbackText: boundedText(record.fallbackText, blockLimit) }),
      ...(record.data === undefined ? {} : { data: { truncated: true } }),
    };
  }
  return {
    ...record,
    ...(record.label === undefined ? {} : { label: boundedText(record.label, blockLimit) }),
    ...(record.data === undefined ? {} : { data: { truncated: true } }),
  };
}

function pageFromProjection(
  inventoryId: string,
  projection: ProjectionCacheRecord,
  query: TranscriptQuery | undefined,
  limits: TranscriptProjectionLimits,
  cached: boolean,
): TranscriptPage {
  const limit = pageLimit(query?.limit ?? limits.maxPageRecords, limits.maxPageRecords);
  const direction = query?.direction ?? "older";
  const cursor =
    query?.cursor === undefined
      ? undefined
      : decodePageCursor(query.cursor, inventoryId, projection.sourceFingerprint);
  const total = projection.records.length;
  let start: number;
  let end: number;
  if (cursor === undefined) {
    end = total;
    start = Math.max(0, end - limit);
  } else if (direction === "older") {
    end = Math.min(cursor, total);
    start = Math.max(0, end - limit);
  } else {
    start = Math.min(cursor, total);
    end = Math.min(total, start + limit);
  }
  return {
    inventoryId,
    records: structuredClone(projection.records.slice(start, end)),
    order: "chronological",
    sourceFingerprint: asDashboardFingerprint(projection.sourceFingerprint),
    projection: {
      formatVersion: PROJECTION_CACHE_FORMAT_VERSION,
      cached,
      truncated: projection.truncated,
      builtAt: projection.builtAt,
    },
    hydration: "not-requested",
    ...(projection.piSessionId === undefined ? {} : { piSessionId: projection.piSessionId }),
    ...(projection.currentLeafId === undefined
      ? {}
      : { currentLeafId: projection.currentLeafId }),
    ...(start > 0
      ? { olderCursor: encodePageCursor(inventoryId, projection.sourceFingerprint, start) }
      : {}),
    ...(end < total
      ? { newerCursor: encodePageCursor(inventoryId, projection.sourceFingerprint, end) }
      : {}),
  };
}

function encodePageCursor(
  inventoryId: string,
  fingerprint: string,
  index: number,
): DashboardCursor {
  const encoded = Buffer.from(JSON.stringify({ v: 1, inventoryId, fingerprint, index })).toString(
    "base64url",
  );
  return asDashboardCursor(`tp1.${encoded}`);
}

function decodePageCursor(
  cursor: DashboardCursor,
  inventoryId: string,
  fingerprint: string,
): number {
  if (!cursor.startsWith("tp1.")) {
    throw new TranscriptProjectionError("invalid_cursor", "transcript cursor is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor.slice(4), "base64url").toString("utf8")) as unknown;
  } catch {
    throw new TranscriptProjectionError("invalid_cursor", "transcript cursor is invalid");
  }
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    value.inventoryId !== inventoryId ||
    value.fingerprint !== fingerprint ||
    !Number.isSafeInteger(value.index) ||
    (value.index as number) < 0
  ) {
    throw new TranscriptProjectionError("stale_cursor", "transcript cursor is stale");
  }
  return value.index as number;
}

async function inspectSource(path: string, maxBytes: number) {
  let info;
  try {
    const linkInfo = await lstat(path);
    if (linkInfo.isSymbolicLink()) {
      throw new TranscriptProjectionError(
        "source_not_regular",
        "session source must not be a symbolic link",
      );
    }
    info = await stat(path);
  } catch (error) {
    if (error instanceof TranscriptProjectionError) throw error;
    throw new TranscriptProjectionError("source_unreadable", "session source is unavailable", true);
  }
  validateOpenedSource(info, maxBytes);
  return info;
}

function validateOpenedSource(
  info: {
    isFile(): boolean;
    uid: number;
    mode: number;
    size: number;
  },
  maxBytes: number,
): void {
  if (!info.isFile()) {
    throw new TranscriptProjectionError("source_not_regular", "session source must be a regular file");
  }
  const getuid = process.getuid;
  if (getuid !== undefined && info.uid !== getuid()) {
    throw new TranscriptProjectionError("source_owner_mismatch", "session source must be owned by current user");
  }
  if ((info.mode & 0o022) !== 0) {
    throw new TranscriptProjectionError(
      "source_insecure_mode",
      "session source must not be group/world writable",
    );
  }
  if (info.size > maxBytes) {
    throw new TranscriptProjectionError("source_too_large", "session source exceeds its byte limit");
  }
}

function isProjectionCacheRecord(
  value: unknown,
  limits: TranscriptProjectionLimits,
): value is ProjectionCacheRecord {
  return (
    isRecord(value) &&
    value.formatVersion === PROJECTION_CACHE_FORMAT_VERSION &&
    typeof value.inventoryId === "string" &&
    typeof value.sourceFingerprint === "string" &&
    typeof value.sourceSizeBytes === "number" &&
    typeof value.sourceModifiedMs === "number" &&
    typeof value.builtAt === "string" &&
    typeof value.truncated === "boolean" &&
    Array.isArray(value.records) &&
    value.records.length <= limits.maxEntries &&
    value.records.every(
      (record) =>
        isNormalizedTranscriptRecord(record) && jsonBytes(record) <= limits.maxRecordBytes,
    ) &&
    jsonBytes(value) <= limits.maxCacheEntryBytes
  );
}

function isNormalizedTranscriptRecord(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.recordId !== "string" ||
    value.recordId.length === 0 ||
    !isRecord(value.key) ||
    value.source !== "persisted" ||
    !["message", "tool", "summary", "timeline", "custom"].includes(String(value.kind))
  ) {
    return false;
  }
  return [value.key.entryId, value.key.messageId, value.key.toolCallId].some(
    (identity) => typeof identity === "string" && identity.length > 0,
  );
}

function projectionLimits(
  overrides: Partial<TranscriptProjectionLimits> | undefined,
): TranscriptProjectionLimits {
  const defaults: TranscriptProjectionLimits = {
    maxSourceBytes: DASH_DEFAULT_LIMITS.maxProjectionSourceBytes,
    maxLineBytes: DASH_DEFAULT_LIMITS.maxProjectionLineBytes,
    maxEntries: DASH_DEFAULT_LIMITS.maxProjectionEntries,
    maxOutputBytes: DASH_DEFAULT_LIMITS.maxProjectionOutputBytes,
    maxRecordBytes: DASH_DEFAULT_LIMITS.maxTranscriptRecordBytes,
    maxPageRecords: DASH_DEFAULT_LIMITS.maxTranscriptPageRecords,
    maxCacheEntries: DASH_DEFAULT_LIMITS.maxProjectionCacheEntries,
    maxCacheBytes: DASH_DEFAULT_LIMITS.maxProjectionCacheBytes,
    maxCacheEntryBytes: DASH_DEFAULT_LIMITS.maxProjectionCacheEntryBytes,
    cacheMaxAgeMs: DASH_DEFAULT_LIMITS.projectionCacheMaxAgeMs,
    maxImagePreviewBytes: DASH_DEFAULT_LIMITS.maxImagePreviewBytes,
  };
  const resolved = { ...defaults, ...(overrides ?? {}) };
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
  }
  if (resolved.maxPageRecords > DASH_DEFAULT_LIMITS.maxTranscriptPageRecords) {
    throw new Error("maxPageRecords exceeds the dashboard contract limit");
  }
  if (resolved.maxRecordBytes > resolved.maxCacheEntryBytes) {
    throw new Error("maxRecordBytes must not exceed maxCacheEntryBytes");
  }
  return resolved;
}

function pageLimit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TranscriptProjectionError("invalid_page_limit", "transcript page limit is invalid");
  }
  return value;
}

function validateInventoryId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new TranscriptProjectionError("invalid_inventory_id", "inventory ID is invalid");
  }
}

function boundedText(value: string, maxBytes = DEFAULT_TEXT_BLOCK_BYTES): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return `${bytes.subarray(0, Math.max(0, maxBytes - 32)).toString("utf8")}\n[… truncated …]`;
}

function contentText(value: unknown, maxBytes: number): string {
  if (typeof value === "string") return boundedText(value, maxBytes);
  if (!Array.isArray(value)) return "";
  return boundedText(
    value
      .filter((entry) => isRecord(entry) && entry.type === "text" && typeof entry.text === "string")
      .map((entry) => (entry as { text: string }).text)
      .join("\n"),
    maxBytes,
  );
}

function boundedJson(value: unknown, maxBytes: number): JsonValue {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return { unavailable: true };
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { truncated: true };
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return { unavailable: true };
  }
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
