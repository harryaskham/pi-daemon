/**
 * Bounded, descriptor-safe scanning of approved Pi session roots (bd-5fbf37).
 *
 * Root validation, directory walking, and JSONL handle parsing were extracted
 * from `session-inventory.ts` without behavior change: the same ownership and
 * permission refusals, the same per-file/aggregate byte and entry bounds, the
 * same secret-bearing title suppression, and the same issue codes.
 */

import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { hasForbiddenExposure, hasForeignPathOwner } from "./path-ownership.js";
import { formatSessionSourceFingerprint } from "./source-fingerprint.js";
import {
  IssueCollector,
  SessionInventoryError,
  isRecord,
  nodeErrorCode,
  normalizeSingleLine,
  parseTimestamp,
  positiveTimestamp,
  type CandidateSessionFile,
  type ScannedSessionFile,
  type SessionInventoryLimits,
} from "./session-inventory-contract.js";

export async function validateInventoryRoot(path: string): Promise<string> {
  const info = await lstat(path).catch((error: unknown) => {
    throw new SessionInventoryError(
      "inventory_root_unavailable",
      "configured session inventory root is unavailable",
      true,
      { cause: nodeErrorCode(error) },
    );
  });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new SessionInventoryError(
      "insecure_inventory_root",
      "configured session inventory root must be a real directory",
    );
  }
  const getuid = process.getuid;
  if (hasForeignPathOwner(info.uid, "owner-only", getuid?.())) {
    throw new SessionInventoryError(
      "insecure_inventory_root",
      "configured session inventory root must be owned by current user",
    );
  }
  if (hasForbiddenExposure(info.mode, "no-foreign-writers")) {
    throw new SessionInventoryError(
      "insecure_inventory_root",
      "configured session inventory root must not be group/world writable",
    );
  }
  return realpath(path);
}

export async function collectSessionFiles(
  root: string,
  limits: Readonly<SessionInventoryLimits>,
  issues: IssueCollector,
): Promise<CandidateSessionFile[]> {
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  const candidates: CandidateSessionFile[] = [];
  let entries = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    let directory;
    try {
      directory = await opendir(current.path);
    } catch {
      issues.add("inventory_directory_unreadable");
      continue;
    }
    try {
      for await (const entry of directory) {
        entries += 1;
        if (entries > limits.maxDirectoryEntries) {
          throw new SessionInventoryError(
            "inventory_directory_capacity",
            "session inventory directory entries exceed limit",
            false,
            { maxDirectoryEntries: limits.maxDirectoryEntries },
          );
        }
        const path = join(current.path, entry.name);
        let info;
        try {
          info = await lstat(path);
        } catch {
          issues.add("inventory_entry_unreadable");
          continue;
        }
        if (info.isSymbolicLink()) {
          issues.add("inventory_symlink_skipped");
          continue;
        }
        const getuid = process.getuid;
        if (hasForeignPathOwner(info.uid, "owner-only", getuid?.())) {
          issues.add("inventory_foreign_owner_skipped");
          continue;
        }
        if (info.isDirectory()) {
          if (current.depth >= limits.maxScanDepth) {
            issues.add("inventory_depth_exceeded");
            continue;
          }
          queue.push({ path, depth: current.depth + 1 });
          continue;
        }
        if (!info.isFile() || !entry.name.endsWith(".jsonl")) continue;
        if (info.size > limits.maxSourceBytes) {
          issues.add("inventory_source_too_large");
          continue;
        }
        candidates.push({
          path,
          modifiedMs: info.mtimeMs,
          sizeBytes: info.size,
        });
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  }
  return candidates;
}

export async function scanSessionFile(
  candidate: CandidateSessionFile,
  limits: Readonly<SessionInventoryLimits>,
): Promise<ScannedSessionFile> {
  let handle: FileHandle;
  try {
    handle = await open(candidate.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new SessionInventoryError(
      "inventory_source_unreadable",
      "session source could not be opened safely",
      true,
      { cause: nodeErrorCode(error) },
    );
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new SessionInventoryError(
        "invalid_inventory_source",
        "session source must be a regular file",
      );
    }
    const getuid = process.getuid;
    if (hasForeignPathOwner(info.uid, "owner-only", getuid?.())) {
      throw new SessionInventoryError(
        "inventory_source_foreign_owner",
        "session source must be owned by current user",
      );
    }
    if (info.size > limits.maxSourceBytes) {
      throw new SessionInventoryError(
        "inventory_source_too_large",
        "session source exceeds byte limit",
      );
    }
    return await parseSessionHandle(handle, candidate.path, info, limits);
  } finally {
    await handle.close();
  }
}

export async function parseSessionHandle(
  handle: FileHandle,
  path: string,
  info: Awaited<ReturnType<FileHandle["stat"]>>,
  limits: Readonly<SessionInventoryLimits>,
): Promise<ScannedSessionFile> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let pending = Buffer.alloc(0);
  let header: Record<string, unknown> | undefined;
  let explicitName: string | undefined;
  let firstUserMessage: string | undefined;
  let searchExcerpt = "";
  let messageCount = 0;
  let entryCount = 0;
  let toolCallCount = 0;
  let currentLeafId: string | undefined;
  let lastActivityMs = 0;

  const processLine = (line: Buffer): void => {
    if (line.length === 0) return;
    if (line.length > limits.maxLineBytes) {
      throw new SessionInventoryError(
        "inventory_line_too_large",
        "session source line exceeds byte limit",
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(decoder.decode(line)) as unknown;
    } catch {
      throw new SessionInventoryError(
        "corrupt_inventory_source",
        "session source contains invalid UTF-8 or JSON",
      );
    }
    if (!isRecord(value)) {
      throw new SessionInventoryError(
        "corrupt_inventory_source",
        "session source record must be an object",
      );
    }
    if (header === undefined) {
      if (value.type !== "session") {
        throw new SessionInventoryError(
          "corrupt_inventory_source",
          "session source does not begin with a session header",
        );
      }
      const version = value.version ?? 1;
      if (!Number.isSafeInteger(version) || (version as number) < 1 || (version as number) > 3) {
        throw new SessionInventoryError(
          "unsupported_session_format",
          "session source format is unsupported",
        );
      }
      if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 256) {
        throw new SessionInventoryError(
          "corrupt_inventory_source",
          "session source has an invalid Pi session ID",
        );
      }
      header = value;
      return;
    }
    entryCount += 1;
    if (entryCount > limits.maxEntriesPerSession) {
      throw new SessionInventoryError(
        "inventory_entry_capacity",
        "session source entry count exceeds limit",
      );
    }
    if (typeof value.id === "string" && value.id.length > 0 && value.id.length <= 256) {
      currentLeafId = value.id;
    }
    const entryTime = parseTimestamp(value.timestamp);
    if (entryTime !== undefined) lastActivityMs = Math.max(lastActivityMs, entryTime);
    if (value.type === "session_info") {
      explicitName =
        typeof value.name === "string" && value.name.trim().length > 0
          ? normalizeSingleLine(value.name, limits.maxTitleChars)
          : undefined;
      return;
    }
    if (value.type !== "message" || !isRecord(value.message)) return;
    messageCount += 1;
    const message = value.message;
    const role = message.role;
    if (role !== "user" && role !== "assistant") return;
    const messageTime =
      typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
        ? message.timestamp
        : entryTime;
    if (messageTime !== undefined) lastActivityMs = Math.max(lastActivityMs, messageTime);
    const text = extractMessageText(message, limits.maxSearchExcerptChars);
    if (role === "user" && firstUserMessage === undefined && text.length > 0) {
      firstUserMessage = text;
    }
    if (searchExcerpt.length < limits.maxSearchExcerptChars && text.length > 0) {
      searchExcerpt = `${searchExcerpt} ${text}`.slice(0, limits.maxSearchExcerptChars);
    }
    if (role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && block.type === "toolCall") toolCallCount += 1;
      }
    }
  };

  while (true) {
    const read = await handle.read(buffer, 0, buffer.length, null);
    if (read.bytesRead === 0) break;
    const chunk = buffer.subarray(0, read.bytesRead);
    digest.update(chunk);
    pending = Buffer.concat([pending, chunk]);
    while (true) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) break;
      let line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      processLine(line);
    }
    if (pending.length > limits.maxLineBytes) {
      throw new SessionInventoryError(
        "inventory_line_too_large",
        "session source line exceeds byte limit",
      );
    }
  }
  if (pending.length > 0) processLine(pending);
  if (header === undefined) {
    throw new SessionInventoryError("corrupt_inventory_source", "session source is empty");
  }
  const headerTimestamp = parseTimestamp(header.timestamp);
  const fileBirthtimeMs = Number(info.birthtimeMs);
  const fileMtimeMs = Number(info.mtimeMs);
  const createdMs = headerTimestamp ?? positiveTimestamp(fileBirthtimeMs) ?? fileMtimeMs;
  const modifiedMs = lastActivityMs || headerTimestamp || fileMtimeMs;
  const cwd =
    typeof header.cwd === "string" && header.cwd.trim().length > 0
      ? header.cwd
      : "(unknown)";
  const canonicalPath = await realpath(path);
  return {
    canonicalPath,
    piSessionId: header.id as string,
    cwd,
    ...(typeof header.parentSession === "string" && header.parentSession.length > 0
      ? { parentSessionPath: header.parentSession }
      : {}),
    ...(explicitName === undefined ? {} : { explicitName }),
    ...(firstUserMessage === undefined ? {} : { firstUserMessage }),
    createdAt: new Date(createdMs).toISOString(),
    modifiedAt: new Date(modifiedMs).toISOString(),
    messageCount,
    entryCount,
    toolCallCount,
    ...(currentLeafId === undefined ? {} : { currentLeafId }),
    fingerprint: {
      value: formatSessionSourceFingerprint(digest.digest()),
      sizeBytes: Number(info.size),
      modifiedAt: new Date(fileMtimeMs).toISOString(),
      device: String(info.dev),
      inode: String(info.ino),
    },
    searchExcerpt,
  };
}

export function extractMessageText(message: Record<string, unknown>, maxChars: number): string {
  const content = message.content;
  if (typeof content === "string") return normalizeSingleLine(content, maxChars);
  if (!Array.isArray(content)) return "";
  let value = "";
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    value = `${value} ${block.text}`.slice(0, maxChars);
    if (value.length >= maxChars) break;
  }
  return normalizeSingleLine(value, maxChars);
}

export function titleFor(
  explicitName: string | undefined,
  catalogName: string | undefined,
  firstUserMessage: string | undefined,
  inventoryId: string,
  maxChars: number,
): string {
  if (explicitName !== undefined) return normalizeSingleLine(explicitName, maxChars);
  if (catalogName !== undefined) return normalizeSingleLine(catalogName, maxChars);
  if (firstUserMessage !== undefined && !looksSecretBearing(firstUserMessage)) {
    const words = normalizeSingleLine(firstUserMessage, maxChars).split(" ").slice(0, 8).join(" ");
    if (words.length > 0) return words;
  }
  return `Untitled session ${inventoryId.slice(-8)}`;
}

export function looksSecretBearing(value: string): boolean {
  return /(?:bearer|password|passwd|secret|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|sk-[a-z0-9_-]{6,})/i.test(
    value,
  );
}
