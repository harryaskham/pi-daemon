import { constants } from "node:fs";
import {
  lstat,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  type FileHandle,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { performance } from "node:perf_hooks";
import { deserialize, serialize } from "node:v8";
import { TextDecoder } from "node:util";

import {
  DASH_DEFAULT_LIMITS,
  asDashboardCursor,
} from "./dashboard-contract.js";
import type {
  DashSessionPresence,
  DashboardCursor,
  DashboardSourceKind,
  ManagedSessionSummary,
  SessionInfoResource,
  SessionInventoryActivation,
  SessionInventoryPage,
  SessionInventoryQuery,
  SessionInventoryRecord,
  SessionOwnershipInfo,
  SessionSourceFingerprint,
} from "./dashboard-contract.js";
import {
  DEFAULT_PI_DAEMON_WEB_CONFIG,
  type LoadedPiDaemonConfig,
} from "./config.js";
import {
  atomicWritePrivateBytes,
  atomicWritePrivateJson,
  ensurePrivateDirectory,
  readPrivateJsonIfExists,
  stateFileSize,
  validatePrivateFileIfExists,
} from "./durability.js";
import { formatSessionSourceFingerprint } from "./source-fingerprint.js";
import type {
  SessionCatalogRecord,
  SessionCatalogStore,
} from "./session-catalog.js";

export const SESSION_INVENTORY_FORMAT_VERSION = 1 as const;
export const SESSION_INVENTORY_SEARCH_KEY_VERSION = 1 as const;
export const SESSION_INVENTORY_SNAPSHOT_VERSION = 1 as const;

const INVENTORY_SNAPSHOT_MAGIC = Buffer.from("PIDMINV1", "ascii");
const INVENTORY_SNAPSHOT_HEADER_BYTES = 46;

export interface SessionInventoryLimits {
  maxRoots: number;
  maxSessions: number;
  maxIndexBytes: number;
  maxRecordBytes: number;
  indexMaxAgeMs: number;
  reconcileIntervalMs: number;
  maxSourceBytes: number;
  maxAggregateSourceBytes: number;
  maxLineBytes: number;
  maxScanDepth: number;
  maxDirectoryEntries: number;
  maxSearchExcerptChars: number;
  searchBloomBytes: number;
  maxTitleChars: number;
  maxEntriesPerSession: number;
}

export const DEFAULT_SESSION_INVENTORY_LIMITS = {
  maxRoots: DASH_DEFAULT_LIMITS.maxInventoryRoots,
  maxSessions: DASH_DEFAULT_LIMITS.maxIndexedSessions,
  maxIndexBytes: DASH_DEFAULT_LIMITS.maxInventoryIndexBytes,
  maxRecordBytes: DASH_DEFAULT_LIMITS.maxInventoryRecordBytes,
  indexMaxAgeMs: DASH_DEFAULT_LIMITS.inventoryIndexMaxAgeMs,
  reconcileIntervalMs: DASH_DEFAULT_LIMITS.inventoryReconcileIntervalMs,
  maxSourceBytes: DASH_DEFAULT_LIMITS.maxProjectionSourceBytes,
  maxAggregateSourceBytes: 4_294_967_296,
  maxLineBytes: DASH_DEFAULT_LIMITS.maxProjectionLineBytes,
  maxScanDepth: 8,
  maxDirectoryEntries: 100_000,
  maxSearchExcerptChars: 4_096,
  searchBloomBytes: 256,
  maxTitleChars: 256,
  maxEntriesPerSession: DASH_DEFAULT_LIMITS.maxProjectionEntries,
} as const satisfies SessionInventoryLimits;

export interface ResolvedSessionInventoryConfig {
  roots: string[];
  limits: Pick<SessionInventoryLimits, "maxSessions" | "reconcileIntervalMs">;
}

/** Resolve raw YAML inventory roots relative to the selected instance config. */
export function resolveSessionInventoryConfig(
  loaded: LoadedPiDaemonConfig,
  options: { defaultSessionRoot?: string } = {},
): ResolvedSessionInventoryConfig {
  const configured = loaded.config.web?.inventory;
  const roots = [
    ...(options.defaultSessionRoot === undefined
      ? []
      : [resolve(options.defaultSessionRoot)]),
    ...(configured?.roots ?? DEFAULT_PI_DAEMON_WEB_CONFIG.inventory.roots).map((root) =>
      loaded.resolvePath(root),
    ),
  ];
  return {
    roots: [...new Set(roots)],
    limits: {
      maxSessions:
        configured?.maxSessions ?? DEFAULT_PI_DAEMON_WEB_CONFIG.inventory.maxSessions,
      reconcileIntervalMs:
        configured?.reconcileIntervalMs ??
        DEFAULT_PI_DAEMON_WEB_CONFIG.inventory.reconcileIntervalMs,
    },
  };
}

export interface SessionInventoryActivationInput {
  inventoryId: string;
  sourceKind: DashboardSourceKind;
  canonicalPath?: string;
  cwd: string;
  piSessionId?: string;
  managed?: ManagedSessionSummary;
}

export type SessionInventoryActivationPolicy = (
  input: SessionInventoryActivationInput,
) => SessionInventoryActivation | Promise<SessionInventoryActivation>;

export interface SessionInventoryOwnershipResolution {
  sourceKind: DashboardSourceKind;
  ownership: SessionOwnershipInfo;
  activation?: SessionInventoryActivation;
}

export type SessionInventoryOwnershipResolver = (
  input: SessionInventoryActivationInput,
) =>
  | SessionInventoryOwnershipResolution
  | undefined
  | Promise<SessionInventoryOwnershipResolution | undefined>;

export interface SessionInventoryOptions {
  stateDir: string;
  catalog: Pick<SessionCatalogStore, "recover">;
  roots?: readonly string[];
  activationPolicy?: SessionInventoryActivationPolicy;
  ownershipResolver?: SessionInventoryOwnershipResolver;
  limits?: Partial<SessionInventoryLimits>;
  now?: () => Date;
}

export interface SessionInventoryIssue {
  code: string;
  count: number;
}

export interface SessionInventoryStatus {
  initialized: boolean;
  reconciling: boolean;
  records: number;
  loadedAt?: string;
  reconciledAt?: string;
  stale: boolean;
  lastErrorCode?: string;
  issues: SessionInventoryIssue[];
}

export interface SessionInventoryReconcileResult {
  records: number;
  elapsedMs: number;
  issues: SessionInventoryIssue[];
}

interface PersistedInventoryIndex {
  formatVersion: typeof SESSION_INVENTORY_FORMAT_VERSION;
  searchKeyDigest: string;
  revision: string;
  builtAt: string;
  reconciledAt: string;
  records: StoredInventoryRecord[];
}

interface PersistedInventoryHead {
  formatVersion: typeof SESSION_INVENTORY_FORMAT_VERSION;
  revision: string;
  builtAt: string;
  reconciledAt: string;
  records: SessionInventoryRecord[];
}

interface PersistedSearchKey {
  formatVersion: typeof SESSION_INVENTORY_SEARCH_KEY_VERSION;
  key: string;
}

interface StoredInventoryRecord {
  inventory: SessionInventoryRecord;
  cwd: string;
  canonicalPath?: string;
  fingerprint?: SessionSourceFingerprint;
  ownership: SessionOwnershipInfo;
  diagnostics: Array<{ code: string; message: string; retryable: boolean }>;
  searchBloom: string;
}

interface ScannedSessionFile {
  canonicalPath: string;
  piSessionId: string;
  cwd: string;
  parentSessionPath?: string;
  explicitName?: string;
  firstUserMessage?: string;
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
  entryCount: number;
  toolCallCount: number;
  currentLeafId?: string;
  fingerprint: SessionSourceFingerprint;
  searchExcerpt: string;
}

interface CandidateSessionFile {
  path: string;
  modifiedMs: number;
  sizeBytes: number;
}

interface InventoryCursorValue {
  version: 1;
  revision: string;
  queryDigest: string;
  modifiedAt: string;
  inventoryId: string;
}

class IssueCollector {
  readonly #counts = new Map<string, number>();

  add(code: string, count = 1): void {
    this.#counts.set(code, (this.#counts.get(code) ?? 0) + count);
  }

  list(): SessionInventoryIssue[] {
    return [...this.#counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, count]) => ({ code, count }));
  }
}

/**
 * Persisted, preview-only inventory over managed catalog rows and approved Pi
 * JSONL roots. Request-path list/info calls read only immutable in-memory rows;
 * all filesystem work happens at initialize/reconcile boundaries.
 */
export class SessionInventory {
  readonly stateDir: string;
  readonly roots: readonly string[];
  readonly limits: Readonly<SessionInventoryLimits>;

  readonly #catalog: Pick<SessionCatalogStore, "recover">;
  readonly #activationPolicy: SessionInventoryActivationPolicy | undefined;
  readonly #ownershipResolver: SessionInventoryOwnershipResolver | undefined;
  readonly #now: () => Date;
  readonly #webDir: string;
  readonly #indexPath: string;
  readonly #headPath: string;
  readonly #snapshotPath: string;
  readonly #searchKeyPath: string;

  #records = new Map<string, StoredInventoryRecord>();
  #orderedRecords: StoredInventoryRecord[] = [];
  #orderedPositions = new Map<string, number>();
  #revision = "empty";
  #loadedAt: string | undefined;
  #reconciledAt: string | undefined;
  #searchKey: Buffer | undefined;
  #searchKeyPromise: Promise<void> | undefined;
  #fullIndexLoaded = false;
  #indexHydrating = false;
  #fullIndexPromise: Promise<void> | undefined;
  #searchKeyDigest: string | undefined;
  #initialized = false;
  #initializePromise: Promise<void> | undefined;
  #reconciling = false;
  #lastErrorCode: string | undefined;
  #issues: SessionInventoryIssue[] = [];
  #reconcilePromise: Promise<SessionInventoryReconcileResult> | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: SessionInventoryOptions) {
    if (options.stateDir.length === 0) throw new Error("stateDir must not be empty");
    this.stateDir = resolve(options.stateDir);
    this.roots = Object.freeze([...(options.roots ?? [])].map((root) => resolve(root)));
    this.limits = Object.freeze(resolveInventoryLimits(options.limits));
    if (this.roots.length > this.limits.maxRoots) {
      throw new SessionInventoryError(
        "inventory_root_capacity",
        "session inventory root count exceeds limit",
        false,
        { maxRoots: this.limits.maxRoots, roots: this.roots.length },
      );
    }
    this.#catalog = options.catalog;
    this.#activationPolicy = options.activationPolicy;
    this.#ownershipResolver = options.ownershipResolver;
    this.#now = options.now ?? (() => new Date());
    this.#webDir = join(this.stateDir, "web");
    this.#indexPath = join(this.#webDir, "inventory-v1.json");
    this.#headPath = join(this.#webDir, "inventory-v1.head.json");
    this.#snapshotPath = join(this.#webDir, "inventory-v1.snapshot");
    this.#searchKeyPath = join(this.#webDir, "inventory-search-key-v1.json");
  }

  /** Load the private persisted index only; it never scans a session root. */
  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initializePromise ??= this.#runInitialize().finally(() => {
      this.#initializePromise = undefined;
    });
    await this.#initializePromise;
  }

  async #runInitialize(): Promise<void> {
    const headBytes = await stateFileSize(this.#headPath);
    if (headBytes === undefined) {
      await ensurePrivateDirectory(this.stateDir, "state directory");
      await ensurePrivateDirectory(this.#webDir, "dashboard state directory");
    }
    await this.#loadHead(headBytes);
    this.#loadedAt = this.#timestamp();
    this.#initialized = true;
    this.#scheduleFullIndexLoad();
  }

  /** Load immediately, then reconcile now and periodically without blocking callers. */
  async start(): Promise<void> {
    await this.initialize();
    this.#scheduleReconcile();
    if (this.#timer === undefined) {
      this.#timer = setInterval(() => this.#scheduleReconcile(), this.limits.reconcileIntervalMs);
      this.#timer.unref();
    }
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#fullIndexPromise?.catch(() => undefined);
    await this.#reconcilePromise?.catch(() => undefined);
  }

  /** Wait for the full persisted index after the immediate hot-head bootstrap. */
  async waitForFullIndex(): Promise<void> {
    await this.initialize();
    await this.#fullIndexPromise;
  }

  status(): SessionInventoryStatus {
    return {
      initialized: this.#initialized,
      reconciling: this.#reconciling || this.#indexHydrating,
      records: this.#records.size,
      ...(this.#loadedAt === undefined ? {} : { loadedAt: this.#loadedAt }),
      ...(this.#reconciledAt === undefined ? {} : { reconciledAt: this.#reconciledAt }),
      stale: this.#isStale(),
      ...(this.#lastErrorCode === undefined ? {} : { lastErrorCode: this.#lastErrorCode }),
      issues: structuredClone(this.#issues),
    };
  }

  async list(query: SessionInventoryQuery = {}): Promise<SessionInventoryPage> {
    await this.initialize();
    const limit = pageLimit(query.limit ?? 50, this.limits.maxSessions);
    const normalized = normalizeInventoryQuery(query);
    const queryDigest = digestJson(normalized);
    const after =
      query.cursor === undefined
        ? undefined
        : decodeInventoryCursor(query.cursor, this.#revision, queryDigest);
    if (after !== undefined) {
      const position = this.#orderedPositions.get(after.inventoryId);
      const record = position === undefined ? undefined : this.#orderedRecords[position];
      if (record?.inventory.modifiedAt !== after.modifiedAt) {
        throw new SessionInventoryError(
          "invalid_inventory_cursor",
          "inventory cursor does not identify a retained row",
        );
      }
    }
    if (normalized.search.length > 0) {
      await this.waitForFullIndex();
      await this.#ensureSearchKey();
    }
    const searchBits =
      normalized.search.length === 0
        ? []
        : searchBitPositions(
            normalized.search,
            this.#requireSearchKey(),
            this.limits.searchBloomBytes,
            512,
          );

    const selected: StoredInventoryRecord[] = [];
    const start =
      after === undefined
        ? 0
        : (this.#orderedPositions.get(after.inventoryId) ?? -1) + 1;
    let visited = 0;
    for (let index = start; index < this.#orderedRecords.length; index += 1) {
      const record = this.#orderedRecords[index]!;
      if (recordMatches(record, normalized, searchBits, this.limits.searchBloomBytes)) {
        selected.push(record);
        if (selected.length > limit) break;
      }
      visited += 1;
      if (visited % 512 === 0) await yieldEventLoop();
    }
    const pageRecords = selected.slice(0, limit);
    const page: SessionInventoryPage = {
      sessions: pageRecords.map((record) => structuredClone(record.inventory)),
      index: {
        formatVersion: SESSION_INVENTORY_FORMAT_VERSION,
        loadedAt: this.#loadedAt ?? this.#timestamp(),
        ...(this.#reconciledAt === undefined ? {} : { reconciledAt: this.#reconciledAt }),
        stale: this.#isStale(),
        reconciling: this.#reconciling || this.#indexHydrating,
      },
    };
    if (selected.length > pageRecords.length) {
      page.nextCursor = encodeInventoryCursor({
        version: 1,
        revision: this.#revision,
        queryDigest,
        modifiedAt: pageRecords[pageRecords.length - 1]!.inventory.modifiedAt,
        inventoryId: pageRecords[pageRecords.length - 1]!.inventory.inventoryId,
      });
    }
    return page;
  }

  async getInfo(inventoryId: string): Promise<SessionInfoResource | undefined> {
    await this.waitForFullIndex();
    const record = this.#records.get(inventoryId);
    if (record === undefined) return undefined;
    const aliases = record.inventory.piSessionId === undefined
      ? []
      : [...this.#records.values()]
          .filter(
            (candidate) =>
              candidate.inventory.inventoryId !== inventoryId &&
              candidate.inventory.piSessionId === record.inventory.piSessionId,
          )
          .map((candidate) => ({
            inventoryId: candidate.inventory.inventoryId,
            ...(candidate.canonicalPath === undefined
              ? {}
              : { canonicalPath: candidate.canonicalPath }),
          }));
    return {
      ...structuredClone(record.inventory),
      cwd: record.cwd,
      source: {
        ...(record.canonicalPath === undefined
          ? {}
          : { canonicalPath: record.canonicalPath }),
        ...(record.fingerprint === undefined
          ? {}
          : { fingerprint: structuredClone(record.fingerprint) }),
        aliases,
      },
      ownership: structuredClone(record.ownership),
      diagnostics: structuredClone(record.diagnostics),
      ...(record.inventory.managed === undefined
        ? {}
        : {
            runtime: {
              readerCount: 0,
              warmLeaseCount: 0,
              isolation: "unisolated",
            },
          }),
    };
  }

  reconcile(): Promise<SessionInventoryReconcileResult> {
    this.#reconcilePromise ??= this.#runReconcile().finally(() => {
      this.#reconcilePromise = undefined;
    });
    return this.#reconcilePromise;
  }

  #scheduleReconcile(): void {
    void this.reconcile().catch(() => undefined);
  }

  async #runReconcile(): Promise<SessionInventoryReconcileResult> {
    await this.initialize();
    await this.#fullIndexPromise;
    const started = performance.now();
    this.#reconciling = true;
    const issues = new IssueCollector();
    try {
      const catalogRecords = await this.#catalog.recover();
      const [canonicalStateDir, roots] = await Promise.all([
        realpath(this.stateDir),
        Promise.all(this.roots.map((root) => validateInventoryRoot(root))),
      ]);
      for (const root of roots) {
        if (isWithin(root, canonicalStateDir) || isWithin(canonicalStateDir, root)) {
          throw new SessionInventoryError(
            "insecure_inventory_root",
            "session inventory roots must not overlap daemon state",
          );
        }
      }
      const candidates: CandidateSessionFile[] = [];
      for (const root of roots) {
        candidates.push(...(await collectSessionFiles(root, this.limits, issues)));
      }
      const deduplicatedCandidates = [...new Map(
        candidates.map((candidate) => [candidate.path, candidate]),
      ).values()];
      deduplicatedCandidates.sort(
        (left, right) =>
          right.modifiedMs - left.modifiedMs || left.path.localeCompare(right.path),
      );
      if (deduplicatedCandidates.length > this.limits.maxSessions) {
        issues.add(
          "inventory_candidate_capacity",
          deduplicatedCandidates.length - this.limits.maxSessions,
        );
        deduplicatedCandidates.length = this.limits.maxSessions;
      }

      let claimedBytes = 0;
      const admitted: CandidateSessionFile[] = [];
      for (const candidate of deduplicatedCandidates) {
        if (claimedBytes + candidate.sizeBytes > this.limits.maxAggregateSourceBytes) {
          issues.add(
            "inventory_scan_bytes_exceeded",
            deduplicatedCandidates.length - admitted.length,
          );
          break;
        }
        claimedBytes += candidate.sizeBytes;
        admitted.push(candidate);
      }
      const scanned = (
        await mapConcurrent(admitted, 8, async (candidate) => {
          try {
            return await scanSessionFile(candidate, this.limits);
          } catch (error) {
            issues.add(inventoryIssueCode(error));
            return undefined;
          }
        })
      ).filter((value): value is ScannedSessionFile => value !== undefined);

      const records = await this.#merge(scanned, catalogRecords, issues);
      records.sort((left, right) => left.inventory.inventoryId.localeCompare(right.inventory.inventoryId));
      if (records.length > this.limits.maxSessions) {
        records.sort(compareStoredRecords);
        issues.add("inventory_record_capacity", records.length - this.limits.maxSessions);
        records.length = this.limits.maxSessions;
        records.sort((left, right) => left.inventory.inventoryId.localeCompare(right.inventory.inventoryId));
      }
      for (const record of records) validateStoredRecord(record, this.limits);

      const now = this.#timestamp();
      const revision = inventoryRevision(records);
      const orderedRecords = [...records].sort(compareStoredRecords);
      const index: PersistedInventoryIndex = {
        formatVersion: SESSION_INVENTORY_FORMAT_VERSION,
        searchKeyDigest: this.#requireSearchKeyDigest(),
        revision,
        builtAt: now,
        reconciledAt: now,
        records: orderedRecords,
      };
      const bytes = Buffer.byteLength(JSON.stringify(index), "utf8");
      if (bytes > this.limits.maxIndexBytes) {
        throw new SessionInventoryError(
          "inventory_index_too_large",
          "session inventory index exceeds byte limit",
          false,
          { maxIndexBytes: this.limits.maxIndexBytes, indexBytes: bytes },
        );
      }
      const head: PersistedInventoryHead = {
        formatVersion: SESSION_INVENTORY_FORMAT_VERSION,
        revision,
        builtAt: now,
        reconciledAt: now,
        records: orderedRecords
          .slice(0, DASH_DEFAULT_LIMITS.maxInventoryPageItems + 1)
          .map((record) => record.inventory),
      };
      await this.#writeSnapshot(index);
      await atomicWritePrivateJson(this.#indexPath, index);
      await atomicWritePrivateJson(this.#headPath, head);
      this.#installRecords(orderedRecords, true);
      this.#fullIndexLoaded = true;
      this.#revision = revision;
      this.#reconciledAt = now;
      this.#issues = issues.list();
      this.#lastErrorCode = undefined;
      return {
        records: records.length,
        elapsedMs: performance.now() - started,
        issues: structuredClone(this.#issues),
      };
    } catch (error) {
      this.#lastErrorCode = inventoryIssueCode(error);
      throw error;
    } finally {
      this.#reconciling = false;
    }
  }

  async #merge(
    scanned: ScannedSessionFile[],
    catalogRecords: SessionCatalogRecord[],
    issues: IssueCollector,
  ): Promise<StoredInventoryRecord[]> {
    const catalogByPath = new Map<string, SessionCatalogRecord>();
    const consumedManaged = new Set<string>();
    for (const record of catalogRecords) {
      const file = record.conversation?.sessionFile;
      if (file === undefined) continue;
      const canonical = await realpath(file).catch(() => resolve(file));
      if (catalogByPath.has(canonical)) {
        issues.add("inventory_duplicate_managed_conversation_path");
        continue;
      }
      catalogByPath.set(canonical, record);
    }
    const piIds = new Map<string, number>();
    for (const item of scanned) {
      piIds.set(item.piSessionId, (piIds.get(item.piSessionId) ?? 0) + 1);
    }
    for (const count of piIds.values()) {
      if (count > 1) issues.add("inventory_duplicate_pi_session_id", count);
    }
    const piIdByPath = new Map(scanned.map((item) => [item.canonicalPath, item.piSessionId]));
    const records: StoredInventoryRecord[] = [];
    for (const file of scanned) {
      const catalog = catalogByPath.get(file.canonicalPath);
      if (catalog !== undefined) consumedManaged.add(catalog.sessionId);
      const managed = catalog === undefined ? undefined : managedSummary(catalog);
      const defaultKind: DashboardSourceKind = catalog === undefined ? "external" : "managed";
      const inventoryId = inventoryIdFor("file", file.canonicalPath);
      const activationInput: SessionInventoryActivationInput = {
        inventoryId,
        sourceKind: defaultKind,
        canonicalPath: file.canonicalPath,
        cwd: file.cwd,
        piSessionId: file.piSessionId,
        ...(managed === undefined ? {} : { managed }),
      };
      const ownership = await this.#resolveOwnership(activationInput);
      const sourceKind = ownership?.sourceKind ?? defaultKind;
      activationInput.sourceKind = sourceKind;
      const title = titleFor(
        file.explicitName,
        catalog?.name,
        file.firstUserMessage,
        inventoryId,
        this.limits.maxTitleChars,
      );
      const activation =
        ownership?.activation ?? (await this.#activation(activationInput));
      const duplicate = (piIds.get(file.piSessionId) ?? 0) > 1;
      records.push({
        inventory: {
          inventoryId,
          sourceKind,
          title,
          cwdBasename: cwdBasename(file.cwd),
          projectLabel: cwdBasename(file.cwd),
          piSessionId: file.piSessionId,
          ...(file.parentSessionPath === undefined ||
          piIdByPath.get(resolve(file.parentSessionPath)) === undefined
            ? {}
            : { parentPiSessionId: piIdByPath.get(resolve(file.parentSessionPath))! }),
          createdAt: file.createdAt,
          modifiedAt: file.modifiedAt,
          messageCount: file.messageCount,
          entryCount: file.entryCount,
          toolCallCount: file.toolCallCount,
          ...(file.currentLeafId === undefined ? {} : { currentLeafId: file.currentLeafId }),
          ...(managed === undefined ? {} : { managed }),
          activation,
          presence: presenceFor(catalog),
        },
        cwd: file.cwd,
        canonicalPath: file.canonicalPath,
        fingerprint: file.fingerprint,
        ownership: ownership?.ownership ?? { mode: catalog === undefined ? "none" : "direct" },
        diagnostics: duplicate
          ? [
              {
                code: "duplicate_pi_session_id",
                message: "multiple source files declare the same Pi session ID",
                retryable: false,
              },
            ]
          : [],
        searchBloom: this.#searchBloom(
          [
            title,
            file.cwd,
            file.piSessionId,
            catalog?.sessionId ?? "",
            catalog?.name ?? "",
            file.searchExcerpt,
          ].join(" "),
        ),
      });
    }

    for (const catalog of catalogRecords) {
      if (consumedManaged.has(catalog.sessionId)) continue;
      const inventoryId = inventoryIdFor("managed", catalog.sessionId);
      const sourceKind: DashboardSourceKind =
        catalog.spec.target.mode === "memory" || catalog.conversation?.sessionFile === undefined
          ? "memory"
          : "managed";
      const managed = managedSummary(catalog);
      const activationInput: SessionInventoryActivationInput = {
        inventoryId,
        sourceKind,
        cwd: catalog.spec.cwd,
        ...(catalog.conversation === undefined
          ? {}
          : { piSessionId: catalog.conversation.sessionId }),
        managed,
      };
      const ownership = await this.#resolveOwnership(activationInput);
      const effectiveKind = ownership?.sourceKind ?? sourceKind;
      activationInput.sourceKind = effectiveKind;
      const title = titleFor(
        undefined,
        catalog.name,
        undefined,
        inventoryId,
        this.limits.maxTitleChars,
      );
      records.push({
        inventory: {
          inventoryId,
          sourceKind: effectiveKind,
          title,
          cwdBasename: cwdBasename(catalog.spec.cwd),
          projectLabel: cwdBasename(catalog.spec.cwd),
          ...(catalog.conversation === undefined
            ? {}
            : { piSessionId: catalog.conversation.sessionId }),
          createdAt: catalog.createdAt,
          modifiedAt: catalog.updatedAt,
          messageCount: 0,
          managed,
          activation:
            ownership?.activation ?? (await this.#activation(activationInput)),
          presence: presenceFor(catalog),
        },
        cwd: catalog.spec.cwd,
        ...(catalog.conversation?.sessionFile === undefined
          ? {}
          : { canonicalPath: resolve(catalog.conversation.sessionFile) }),
        ownership: ownership?.ownership ?? { mode: sourceKind === "memory" ? "none" : "direct" },
        diagnostics: [],
        searchBloom: this.#searchBloom(
          [title, catalog.spec.cwd, catalog.sessionId, catalog.name ?? ""].join(" "),
        ),
      });
    }
    return records;
  }

  async #resolveOwnership(
    input: SessionInventoryActivationInput,
  ): Promise<SessionInventoryOwnershipResolution | undefined> {
    return this.#ownershipResolver?.(structuredClone(input));
  }

  async #activation(
    input: SessionInventoryActivationInput,
  ): Promise<SessionInventoryActivation> {
    if (this.#activationPolicy !== undefined) {
      const activation = await this.#activationPolicy(structuredClone(input));
      validateActivation(activation);
      return structuredClone(activation);
    }
    if (input.managed !== undefined) return { eligible: true, modes: ["reuse"] };
    if (input.cwd === "(unknown)" || !isAbsolute(input.cwd)) {
      return {
        eligible: false,
        modes: ["preview-only"],
        reasonCode: "missing-or-invalid-cwd",
      };
    }
    return {
      eligible: false,
      modes: ["preview-only"],
      reasonCode: "activation-policy-required",
    };
  }

  #searchBloom(value: string): string {
    return buildSearchBloom(
      normalizeSearch(value).slice(0, this.limits.maxSearchExcerptChars),
      this.#requireSearchKey(),
      this.limits.searchBloomBytes,
    );
  }

  async #ensureSearchKey(): Promise<void> {
    if (this.#searchKey !== undefined) return;
    this.#searchKeyPromise ??= this.#loadSearchKey().finally(() => {
      this.#searchKeyPromise = undefined;
    });
    await this.#searchKeyPromise;
  }

  async #loadSearchKey(): Promise<void> {
    const bytes = await stateFileSize(this.#searchKeyPath);
    if (bytes !== undefined && bytes > 4096) {
      await this.#quarantine(this.#searchKeyPath, "search-key-too-large");
    }
    let value: PersistedSearchKey | undefined;
    try {
      value = await readPrivateJsonIfExists<PersistedSearchKey>(this.#searchKeyPath);
      if (
        value !== undefined &&
        (value.formatVersion !== SESSION_INVENTORY_SEARCH_KEY_VERSION ||
          !/^[a-f0-9]{64}$/.test(value.key))
      ) {
        throw new Error("invalid search key");
      }
    } catch {
      await this.#quarantine(this.#searchKeyPath, "search-key-corrupt");
      value = undefined;
    }
    if (value === undefined) {
      value = {
        formatVersion: SESSION_INVENTORY_SEARCH_KEY_VERSION,
        key: randomBytes(32).toString("hex"),
      };
      await atomicWritePrivateJson(this.#searchKeyPath, value);
    }
    this.#searchKey = Buffer.from(value.key, "hex");
    this.#searchKeyDigest = createHash("sha256").update(this.#searchKey).digest("hex");
  }

  async #loadHead(knownBytes?: number): Promise<void> {
    const bytes = knownBytes ?? (await stateFileSize(this.#headPath));
    if (bytes === undefined) return;
    if (bytes > this.limits.maxRecordBytes * (DASH_DEFAULT_LIMITS.maxInventoryPageItems + 2)) {
      await this.#quarantine(this.#headPath, "head-too-large");
      return;
    }
    try {
      const value = await readPrivateJsonIfExists<unknown>(this.#headPath);
      if (value === undefined) return;
      validateInventoryHead(value);
      const emptyBloom = Buffer.alloc(this.limits.searchBloomBytes).toString("base64url");
      this.#installRecords(
        value.records.map((inventory) => ({
          inventory,
          cwd: inventory.cwdBasename ?? "(unknown)",
          ownership: { mode: "none" },
          diagnostics: [],
          searchBloom: emptyBloom,
        })),
        true,
      );
      this.#revision = value.revision;
      this.#reconciledAt = value.reconciledAt;
    } catch {
      await this.#quarantine(this.#headPath, "head-corrupt");
      this.#lastErrorCode = "corrupt_inventory_head";
    }
  }

  #scheduleFullIndexLoad(): void {
    if (this.#fullIndexPromise !== undefined || this.#fullIndexLoaded) return;
    this.#indexHydrating = true;
    this.#fullIndexPromise = new Promise<void>((resolvePromise) =>
      setImmediate(resolvePromise),
    )
      .then(async () => {
        await ensurePrivateDirectory(this.stateDir, "state directory");
        await ensurePrivateDirectory(this.#webDir, "dashboard state directory");
        await this.#ensureSearchKey();
        await this.#loadIndex();
      })
      .catch((error: unknown) => {
        this.#lastErrorCode = inventoryIssueCode(error);
      })
      .finally(() => {
        this.#fullIndexLoaded = true;
        this.#indexHydrating = false;
      });
  }

  async #loadIndex(): Promise<void> {
    if (await this.#loadSnapshot()) return;
    const bytes = await stateFileSize(this.#indexPath);
    if (bytes === undefined) return;
    if (bytes > this.limits.maxIndexBytes) {
      await this.#quarantine(this.#indexPath, "index-too-large");
      this.#lastErrorCode = "inventory_index_too_large";
      return;
    }
    try {
      const value = await readPrivateJsonIfExists<unknown>(this.#indexPath);
      if (value === undefined) return;
      validatePersistedIndex(value, this.limits, this.#requireSearchKeyDigest());
      this.#installRecords(value.records, true);
      this.#revision = value.revision;
      this.#reconciledAt = value.reconciledAt;
      this.#lastErrorCode = undefined;
    } catch {
      await this.#quarantine(this.#indexPath, "index-corrupt");
      this.#lastErrorCode = "corrupt_inventory_index";
    }
  }

  async #loadSnapshot(): Promise<boolean> {
    const bytes = await stateFileSize(this.#snapshotPath);
    if (bytes === undefined) return false;
    if (bytes > this.limits.maxIndexBytes + INVENTORY_SNAPSHOT_HEADER_BYTES) {
      await this.#quarantine(this.#snapshotPath, "snapshot-too-large");
      return false;
    }
    try {
      await validatePrivateFileIfExists(this.#snapshotPath, "dashboard inventory snapshot");
      const encoded = await readFile(this.#snapshotPath);
      const value = decodeInventorySnapshot(encoded, this.#requireSearchKey());
      if (value === undefined) return false;
      validateSnapshotIndex(value, this.limits, this.#requireSearchKeyDigest());
      this.#installRecords(value.records, true);
      this.#revision = value.revision;
      this.#reconciledAt = value.reconciledAt;
      this.#lastErrorCode = undefined;
      return true;
    } catch {
      await this.#quarantine(this.#snapshotPath, "snapshot-corrupt");
      return false;
    }
  }

  async #writeSnapshot(index: PersistedInventoryIndex): Promise<void> {
    const encoded = encodeInventorySnapshot(index, this.#requireSearchKey());
    if (encoded.byteLength > this.limits.maxIndexBytes + INVENTORY_SNAPSHOT_HEADER_BYTES) {
      throw new SessionInventoryError(
        "inventory_snapshot_too_large",
        "session inventory snapshot exceeds byte limit",
      );
    }
    await atomicWritePrivateBytes(this.#snapshotPath, encoded);
  }

  async #quarantine(path: string, reason: string): Promise<void> {
    try {
      await validatePrivateFileIfExists(path, "dashboard inventory state");
      await rename(path, `${path}.quarantine-${reason}-${randomUUID()}`);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
  }

  #installRecords(records: StoredInventoryRecord[], alreadyOrdered: boolean): void {
    this.#orderedRecords = alreadyOrdered ? records : [...records].sort(compareStoredRecords);
    this.#records = new Map(
      this.#orderedRecords.map((record) => [record.inventory.inventoryId, record]),
    );
    this.#orderedPositions = new Map(
      this.#orderedRecords.map((record, index) => [record.inventory.inventoryId, index]),
    );
  }

  #requireSearchKey(): Buffer {
    if (this.#searchKey === undefined) throw new Error("inventory search key is not loaded");
    return this.#searchKey;
  }

  #requireSearchKeyDigest(): string {
    if (this.#searchKeyDigest === undefined) {
      throw new Error("inventory search key digest is not loaded");
    }
    return this.#searchKeyDigest;
  }

  #isStale(): boolean {
    if (
      this.#lastErrorCode !== undefined ||
      this.#reconciledAt === undefined ||
      !this.#fullIndexLoaded
    ) {
      return true;
    }
    const age = this.#now().getTime() - Date.parse(this.#reconciledAt);
    return !Number.isFinite(age) || age > this.limits.indexMaxAgeMs;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

export class SessionInventoryError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: string,
    message: string,
    retryable = false,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SessionInventoryError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

async function validateInventoryRoot(path: string): Promise<string> {
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
  if (getuid !== undefined && info.uid !== getuid()) {
    throw new SessionInventoryError(
      "insecure_inventory_root",
      "configured session inventory root must be owned by current user",
    );
  }
  if ((info.mode & 0o022) !== 0) {
    throw new SessionInventoryError(
      "insecure_inventory_root",
      "configured session inventory root must not be group/world writable",
    );
  }
  return realpath(path);
}

async function collectSessionFiles(
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
        if (getuid !== undefined && info.uid !== getuid()) {
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

async function scanSessionFile(
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
    if (getuid !== undefined && info.uid !== getuid()) {
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

async function parseSessionHandle(
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

function extractMessageText(message: Record<string, unknown>, maxChars: number): string {
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

function titleFor(
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

function looksSecretBearing(value: string): boolean {
  return /(?:bearer|password|passwd|secret|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|sk-[a-z0-9_-]{6,})/i.test(
    value,
  );
}

function managedSummary(record: SessionCatalogRecord): ManagedSessionSummary {
  return {
    sessionId: record.sessionId,
    ...(record.name === undefined ? {} : { name: record.name }),
    generation: record.generation,
    revision: record.revision,
    residency: record.residency,
    state: record.state,
  };
}

function presenceFor(record: SessionCatalogRecord | undefined): DashSessionPresence {
  if (record === undefined) {
    return {
      runtime: "unmanaged",
      activation: "untouched",
      focusedPaneCount: 0,
      unread: false,
    };
  }
  const runtime: DashSessionPresence["runtime"] =
    record.state === "failed"
      ? "failed"
      : record.state === "running"
        ? "running"
        : record.residency === "dormant"
          ? "dormant"
          : "resident-idle";
  return {
    runtime,
    activation: record.state === "running" ? "running-at-dash-start" : "untouched",
    focusedPaneCount: 0,
    unread: false,
  };
}

function inventoryIdFor(kind: string, source: string): string {
  const digest = createHash("sha256")
    .update(`${SESSION_INVENTORY_FORMAT_VERSION}\0${kind}\0${source}`, "utf8")
    .digest("base64url");
  return `inventory-${digest.slice(0, 32)}`;
}

function inventoryRevision(records: StoredInventoryRecord[]): string {
  const hash = createHash("sha256");
  for (const record of records) {
    hash.update(record.inventory.inventoryId);
    hash.update("\0");
    hash.update(record.inventory.modifiedAt);
    hash.update("\0");
    hash.update(record.fingerprint?.value ?? "");
    hash.update("\0");
    hash.update(String(record.inventory.managed?.revision ?? ""));
    hash.update("\n");
  }
  return hash.digest("base64url").slice(0, 32);
}

function validateInventoryHead(value: unknown): asserts value is PersistedInventoryHead {
  if (
    !isRecord(value) ||
    value.formatVersion !== SESSION_INVENTORY_FORMAT_VERSION ||
    typeof value.revision !== "string" ||
    value.revision.length === 0 ||
    typeof value.builtAt !== "string" ||
    typeof value.reconciledAt !== "string" ||
    !Array.isArray(value.records) ||
    value.records.length > DASH_DEFAULT_LIMITS.maxInventoryPageItems + 1
  ) {
    throw new SessionInventoryError(
      "corrupt_inventory_head",
      "inventory hot-head metadata is invalid",
    );
  }
  for (const record of value.records) {
    if (
      !isRecord(record) ||
      typeof record.inventoryId !== "string" ||
      typeof record.title !== "string" ||
      typeof record.modifiedAt !== "string" ||
      "canonicalPath" in record ||
      "searchBloom" in record
    ) {
      throw new SessionInventoryError(
        "corrupt_inventory_head",
        "inventory hot-head record is invalid",
      );
    }
  }
}

function encodeInventorySnapshot(
  index: PersistedInventoryIndex,
  key: Buffer,
): Buffer {
  const payload = serialize(index);
  const header = Buffer.alloc(INVENTORY_SNAPSHOT_HEADER_BYTES);
  INVENTORY_SNAPSHOT_MAGIC.copy(header, 0);
  header.writeUInt8(SESSION_INVENTORY_SNAPSHOT_VERSION, 8);
  header.writeUInt8(currentNodeMajor(), 9);
  header.writeUInt32BE(payload.byteLength, 10);
  const signature = createHmac("sha256", key)
    .update(header.subarray(0, 14))
    .update(payload)
    .digest();
  signature.copy(header, 14);
  return Buffer.concat([header, payload]);
}

function decodeInventorySnapshot(
  encoded: Buffer,
  key: Buffer,
): unknown | undefined {
  if (
    encoded.byteLength < INVENTORY_SNAPSHOT_HEADER_BYTES ||
    !encoded.subarray(0, 8).equals(INVENTORY_SNAPSHOT_MAGIC) ||
    encoded.readUInt8(8) !== SESSION_INVENTORY_SNAPSHOT_VERSION
  ) {
    throw new SessionInventoryError(
      "corrupt_inventory_snapshot",
      "inventory snapshot header is invalid",
    );
  }
  if (encoded.readUInt8(9) !== currentNodeMajor()) return undefined;
  const payloadBytes = encoded.readUInt32BE(10);
  if (payloadBytes !== encoded.byteLength - INVENTORY_SNAPSHOT_HEADER_BYTES) {
    throw new SessionInventoryError(
      "corrupt_inventory_snapshot",
      "inventory snapshot length is invalid",
    );
  }
  const payload = encoded.subarray(INVENTORY_SNAPSHOT_HEADER_BYTES);
  const expected = createHmac("sha256", key)
    .update(encoded.subarray(0, 14))
    .update(payload)
    .digest();
  const received = encoded.subarray(14, 46);
  if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) {
    throw new SessionInventoryError(
      "corrupt_inventory_snapshot",
      "inventory snapshot authentication failed",
    );
  }
  return deserialize(payload);
}

function validateSnapshotIndex(
  value: unknown,
  limits: Readonly<SessionInventoryLimits>,
  searchKeyDigest?: string,
): asserts value is PersistedInventoryIndex {
  if (
    !isRecord(value) ||
    value.formatVersion !== SESSION_INVENTORY_FORMAT_VERSION ||
    (searchKeyDigest !== undefined && value.searchKeyDigest !== searchKeyDigest) ||
    typeof value.revision !== "string" ||
    value.revision.length === 0 ||
    typeof value.builtAt !== "string" ||
    typeof value.reconciledAt !== "string" ||
    !Array.isArray(value.records) ||
    value.records.length > limits.maxSessions
  ) {
    throw new SessionInventoryError(
      "corrupt_inventory_snapshot",
      "inventory snapshot metadata is invalid",
    );
  }
  for (const record of value.records) {
    if (
      !isRecord(record) ||
      !isRecord(record.inventory) ||
      typeof record.inventory.inventoryId !== "string" ||
      typeof record.inventory.modifiedAt !== "string" ||
      typeof record.inventory.title !== "string"
    ) {
      throw new SessionInventoryError(
        "corrupt_inventory_snapshot",
        "inventory snapshot record is invalid",
      );
    }
  }
}

function currentNodeMajor(): number {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (!Number.isSafeInteger(major) || major < 1 || major > 255) {
    throw new Error("Node major version cannot be encoded in inventory snapshot");
  }
  return major;
}

function validatePersistedIndex(
  value: unknown,
  limits: Readonly<SessionInventoryLimits>,
  searchKeyDigest: string,
): asserts value is PersistedInventoryIndex {
  if (!isRecord(value) || value.formatVersion !== SESSION_INVENTORY_FORMAT_VERSION) {
    throw new SessionInventoryError("corrupt_inventory_index", "inventory index format is invalid");
  }
  if (value.searchKeyDigest !== searchKeyDigest) {
    throw new SessionInventoryError(
      "inventory_search_key_changed",
      "inventory search key no longer matches persisted index",
      true,
    );
  }
  if (
    typeof value.revision !== "string" ||
    value.revision.length === 0 ||
    typeof value.builtAt !== "string" ||
    typeof value.reconciledAt !== "string" ||
    !Array.isArray(value.records) ||
    value.records.length > limits.maxSessions
  ) {
    throw new SessionInventoryError("corrupt_inventory_index", "inventory index metadata is invalid");
  }
  const ids = new Set<string>();
  for (const record of value.records) {
    validateStoredRecord(record, limits, false);
    if (ids.has(record.inventory.inventoryId)) {
      throw new SessionInventoryError("corrupt_inventory_index", "inventory index has duplicate IDs");
    }
    ids.add(record.inventory.inventoryId);
  }
}

function validateStoredRecord(
  value: unknown,
  limits: Readonly<SessionInventoryLimits>,
  measureBytes = true,
): asserts value is StoredInventoryRecord {
  if (!isRecord(value) || !isRecord(value.inventory)) {
    throw new SessionInventoryError("corrupt_inventory_index", "inventory record is invalid");
  }
  const inventory = value.inventory;
  if (
    typeof inventory.inventoryId !== "string" ||
    inventory.inventoryId.length === 0 ||
    typeof inventory.title !== "string" ||
    inventory.title.length === 0 ||
    inventory.title.length > limits.maxTitleChars ||
    typeof inventory.modifiedAt !== "string" ||
    typeof inventory.createdAt !== "string" ||
    typeof value.cwd !== "string" ||
    !isRecord(inventory.activation) ||
    !isRecord(inventory.presence) ||
    !isRecord(value.ownership) ||
    !Array.isArray(value.diagnostics) ||
    typeof value.searchBloom !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value.searchBloom) ||
    Buffer.from(value.searchBloom, "base64url").length !== limits.searchBloomBytes
  ) {
    throw new SessionInventoryError("corrupt_inventory_index", "inventory record fields are invalid");
  }
  validateActivation(inventory.activation as unknown as SessionInventoryActivation);
  if (measureBytes) {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (bytes > limits.maxRecordBytes) {
      throw new SessionInventoryError(
        "inventory_record_too_large",
        "inventory record exceeds byte limit",
        false,
        { maxRecordBytes: limits.maxRecordBytes, recordBytes: bytes },
      );
    }
  }
}

function validateActivation(value: SessionInventoryActivation): void {
  if (
    typeof value.eligible !== "boolean" ||
    !Array.isArray(value.modes) ||
    value.modes.length === 0 ||
    new Set(value.modes).size !== value.modes.length ||
    !value.modes.every((mode) =>
      (["reuse", "direct", "fork", "preview-only"] as unknown[]).includes(mode),
    ) ||
    (value.reasonCode !== undefined &&
      (typeof value.reasonCode !== "string" || value.reasonCode.length > 128))
  ) {
    throw new SessionInventoryError("invalid_inventory_activation", "inventory activation is invalid");
  }
}

function normalizeInventoryQuery(query: SessionInventoryQuery): {
  search: string;
  sourceKinds: DashboardSourceKind[];
  runtime: DashSessionPresence["runtime"][];
  unread?: boolean;
  modifiedAfter?: string;
} {
  const rawSearch = query.search ?? "";
  if (rawSearch.length > DASH_DEFAULT_LIMITS.maxSearchQueryChars) {
    throw new SessionInventoryError(
      "inventory_search_too_large",
      "inventory search query exceeds character limit",
    );
  }
  const search = normalizeSearch(rawSearch);
  const sourceKinds = [...new Set(query.sourceKinds ?? [])].sort();
  const runtime = [...new Set(query.runtime ?? [])].sort();
  const validKinds: DashboardSourceKind[] = [
    "managed",
    "external",
    "direct",
    "imported",
    "exported",
    "memory",
  ];
  const validRuntime: DashSessionPresence["runtime"][] = [
    "unmanaged",
    "dormant",
    "resident-idle",
    "running",
    "failed",
  ];
  if (sourceKinds.some((kind) => !validKinds.includes(kind))) {
    throw new SessionInventoryError("invalid_inventory_filter", "inventory source filter is invalid");
  }
  if (runtime.some((state) => !validRuntime.includes(state))) {
    throw new SessionInventoryError("invalid_inventory_filter", "inventory runtime filter is invalid");
  }
  if (query.modifiedAfter !== undefined && parseTimestamp(query.modifiedAfter) === undefined) {
    throw new SessionInventoryError(
      "invalid_inventory_filter",
      "inventory modifiedAfter timestamp is invalid",
    );
  }
  return {
    search,
    sourceKinds,
    runtime,
    ...(query.unread === undefined ? {} : { unread: query.unread }),
    ...(query.modifiedAfter === undefined ? {} : { modifiedAfter: query.modifiedAfter }),
  };
}

function recordMatches(
  record: StoredInventoryRecord,
  query: ReturnType<typeof normalizeInventoryQuery>,
  searchBits: number[],
  searchBloomBytes: number,
): boolean {
  if (query.sourceKinds.length > 0 && !query.sourceKinds.includes(record.inventory.sourceKind)) {
    return false;
  }
  if (query.runtime.length > 0 && !query.runtime.includes(record.inventory.presence.runtime)) {
    return false;
  }
  if (query.unread !== undefined && record.inventory.presence.unread !== query.unread) return false;
  if (query.modifiedAfter !== undefined && record.inventory.modifiedAt < query.modifiedAfter) return false;
  if (query.search.length === 0) return true;
  const visible = normalizeSearch(
    [
      record.inventory.title,
      record.inventory.cwdBasename ?? "",
      record.inventory.projectLabel ?? "",
      record.inventory.piSessionId ?? "",
      record.inventory.managed?.sessionId ?? "",
      record.inventory.managed?.name ?? "",
    ].join(" "),
  );
  if (visible.includes(query.search)) return true;
  return (
    searchBits.length > 0 &&
    searchBloomMatches(record.searchBloom, searchBits, searchBloomBytes)
  );
}

function buildSearchBloom(value: string, key: Buffer, bytes: number): string {
  const bloom = Buffer.alloc(bytes);
  for (const bit of searchBitPositions(value, key, bytes, 2048)) {
    bloom[bit >> 3] = bloom[bit >> 3]! | (1 << (bit & 7));
  }
  return bloom.toString("base64url");
}

function searchBitPositions(
  value: string,
  key: Buffer,
  bytes: number,
  maxGrams: number,
): number[] {
  const normalized = normalizeSearch(value);
  if (normalized.length === 0) return [];
  const positions = new Set<number>();
  const grams = normalized.length < 3 ? [`=${normalized}`] : trigrams(normalized);
  const words = normalized
    .split(" ")
    .filter((word) => word.length > 0)
    .map((word) => `w:${word}`);
  const values = [...grams, ...words];
  let seen = 0;
  const seeds = [
    key.readUInt32BE(0),
    key.readUInt32BE(4),
    key.readUInt32BE(8),
    key.readUInt32BE(12),
  ];
  for (const gram of values) {
    for (const seed of seeds) {
      positions.add(keyedGramHash(gram, seed) % (bytes * 8));
    }
    seen += 1;
    if (seen >= maxGrams) break;
  }
  return [...positions];
}

function keyedGramHash(value: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= code >>> 8;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function searchBloomMatches(encoded: string, bits: number[], bytes: number): boolean {
  const bloom = Buffer.from(encoded, "base64url");
  if (bloom.length !== bytes) return false;
  return bits.every((bit) => (bloom[bit >> 3]! & (1 << (bit & 7))) !== 0);
}

function trigrams(value: string): string[] {
  const grams: string[] = [];
  for (let index = 0; index <= value.length - 3; index += 1) {
    grams.push(value.slice(index, index + 3));
  }
  return grams;
}

function normalizeSearch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
}

function normalizeSingleLine(value: string, maxChars: number): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function cwdBasename(cwd: string): string {
  if (cwd === "(unknown)") return "Unknown project";
  return basename(resolve(cwd)) || cwd;
}

function compareStoredRecords(left: StoredInventoryRecord, right: StoredInventoryRecord): number {
  return (
    right.inventory.modifiedAt.localeCompare(left.inventory.modifiedAt) ||
    left.inventory.inventoryId.localeCompare(right.inventory.inventoryId)
  );
}

async function yieldEventLoop(): Promise<void> {
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
}

function encodeInventoryCursor(value: InventoryCursorValue): DashboardCursor {
  return asDashboardCursor(Buffer.from(JSON.stringify(value), "utf8").toString("base64url"));
}

function decodeInventoryCursor(
  cursor: DashboardCursor,
  revision: string,
  queryDigest: string,
): InventoryCursorValue {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new SessionInventoryError("invalid_inventory_cursor", "inventory cursor is invalid");
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.revision !== "string" ||
    typeof value.queryDigest !== "string" ||
    typeof value.modifiedAt !== "string" ||
    typeof value.inventoryId !== "string"
  ) {
    throw new SessionInventoryError("invalid_inventory_cursor", "inventory cursor is invalid");
  }
  if (value.revision !== revision || value.queryDigest !== queryDigest) {
    throw new SessionInventoryError(
      "stale_inventory_cursor",
      "inventory cursor no longer matches the current index or filters",
      true,
    );
  }
  return value as unknown as InventoryCursorValue;
}

function pageLimit(limit: number, maxSessions: number): number {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > DASH_DEFAULT_LIMITS.maxInventoryPageItems ||
    limit > maxSessions
  ) {
    throw new SessionInventoryError(
      "invalid_inventory_limit",
      `inventory page limit must be between 1 and ${Math.min(
        DASH_DEFAULT_LIMITS.maxInventoryPageItems,
        maxSessions,
      )}`,
    );
  }
  return limit;
}

function resolveInventoryLimits(
  overrides: Partial<SessionInventoryLimits> | undefined,
): SessionInventoryLimits {
  const value = { ...DEFAULT_SESSION_INVENTORY_LIMITS, ...overrides };
  for (const [field, number] of Object.entries(value)) {
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new Error(`${field} must be a positive safe integer`);
    }
  }
  if (value.maxRecordBytes > value.maxIndexBytes) {
    throw new Error("maxRecordBytes must not exceed maxIndexBytes");
  }
  if (value.maxLineBytes > value.maxSourceBytes) {
    throw new Error("maxLineBytes must not exceed maxSourceBytes");
  }
  return value;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= values.length) return;
        results[index] = await operation(values[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("base64url");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveTimestamp(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function isWithin(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function inventoryIssueCode(error: unknown): string {
  if (error instanceof SessionInventoryError) return error.code;
  return `inventory_${nodeErrorCode(error) ?? "failure"}`;
}

function nodeErrorCode(error: unknown): string | undefined {
  return isNodeError(error) && typeof error.code === "string" ? error.code : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
