import { readFile, realpath, rename } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { DASH_DEFAULT_LIMITS } from "./dashboard-contract.js";
import type {
  SessionInventoryActivation,
} from "./dashboard-contract.js";
import type {
  DashSessionPresence,
  DashboardSourceKind,
  ManagedSessionSummary,
  SessionInfoResource,
  SessionInventoryPage,
  SessionInventoryQuery,
  SessionInventoryRecord,
} from "./dashboard-contract.js";
import {
  atomicWritePrivateBytes,
  atomicWritePrivateJson,
  ensurePrivateDirectory,
  readPrivateJsonIfExists,
  stateFileSize,
  validatePrivateFileIfExists,
} from "./durability.js";
import type { SessionCatalogRecord, SessionCatalogStore } from "./session-catalog.js";
import {
  DEFAULT_SESSION_INVENTORY_LIMITS,
  IssueCollector,
  SESSION_INVENTORY_FORMAT_VERSION,
  INVENTORY_SNAPSHOT_HEADER_BYTES,
  SESSION_INVENTORY_SEARCH_KEY_VERSION,
  SessionInventoryError,
  cwdBasename,
  digestJson,
  inventoryIssueCode,
  isNodeError,
  isWithin,
  mapConcurrent,
  parseTimestamp,
  yieldEventLoop,
  type CandidateSessionFile,
  type PersistedInventoryHead,
  type PersistedInventoryIndex,
  type PersistedSearchKey,
  type ScannedSessionFile,
  type SessionInventoryActivationInput,
  type SessionInventoryActivationPolicy,
  type SessionInventoryIssue,
  type SessionInventoryOwnershipResolution,
  type SessionInventoryLimits,
  type SessionInventoryOptions,
  type SessionInventoryOwnershipResolver,
  type SessionInventoryReconcileResult,
  type SessionInventoryStatus,
  type StoredInventoryRecord,
} from "./session-inventory-contract.js";
import {
  collectSessionFiles,
  scanSessionFile,
  titleFor,
  validateInventoryRoot,
} from "./session-inventory-scanner.js";
import {
  decodeInventorySnapshot,
  encodeInventoryHeadSnapshot,
  encodeInventorySnapshot,
  readInventoryHeadSnapshotSync,
  readInventoryHeadSync,
  validateInventoryHead,
  validateActivation,
  validatePersistedIndex,
  validateSnapshotIndex,
  validateStoredRecord,
} from "./session-inventory-persistence.js";
import {
  EMPTY_INVENTORY_QUERY_DIGEST,
  buildSearchBloom,
  cloneInventoryRecord,
  compareStoredRecords,
  decodeInventoryCursor,
  encodeInventoryCursor,
  inventoryActivityAt,
  inventoryRevision,
  isUnfilteredInventoryQuery,
  normalizeInventoryQuery,
  pageLimit,
  normalizeSearch,
  recordMatches,
  searchBitPositions,
} from "./session-inventory-query.js";

/**
 * Public SessionInventory surface. Scanner, persistence codec, and query/index
 * internals live in focused sibling modules (bd-5fbf37); every name previously
 * exported from this module is re-exported below so consumers are unaffected.
 */
export {
  DEFAULT_SESSION_INVENTORY_LIMITS,
  SESSION_INVENTORY_FORMAT_VERSION,
  SESSION_INVENTORY_SEARCH_KEY_VERSION,
  SESSION_INVENTORY_SNAPSHOT_VERSION,
  SessionInventoryError,
  resolveSessionInventoryConfig,
  type ResolvedSessionInventoryConfig,
  type SessionInventoryActivationInput,
  type SessionInventoryActivationPolicy,
  type SessionInventoryIssue,
  type SessionInventoryLimits,
  type SessionInventoryOptions,
  type SessionInventoryOwnershipResolution,
  type SessionInventoryOwnershipResolver,
  type SessionInventoryReconcileResult,
  type SessionInventoryStatus,
} from "./session-inventory-contract.js";

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
  readonly #headSnapshotPath: string;
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
  #writeTail: Promise<void> = Promise.resolve();
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
    this.#headSnapshotPath = join(this.#webDir, "inventory-v1.head.snapshot");
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
    let head: PersistedInventoryHead | undefined;
    const maxHeadBytes =
      this.limits.maxRecordBytes * (DASH_DEFAULT_LIMITS.maxInventoryPageItems + 2);
    try {
      const value = readInventoryHeadSnapshotSync(this.#headSnapshotPath, maxHeadBytes);
      if (value !== undefined) {
        validateInventoryHead(value);
        head = value;
      }
    } catch {
      await this.#quarantine(this.#headSnapshotPath, "head-snapshot-corrupt");
      this.#lastErrorCode = "corrupt_inventory_head";
    }
    if (head === undefined) {
      try {
        const value = readInventoryHeadSync(this.#headPath, maxHeadBytes);
        if (value !== undefined) {
          validateInventoryHead(value);
          head = value;
        }
      } catch {
        await this.#quarantine(this.#headPath, "head-corrupt");
        this.#lastErrorCode = "corrupt_inventory_head";
      }
    }
    if (head === undefined) {
      await ensurePrivateDirectory(this.stateDir, "state directory");
      await ensurePrivateDirectory(this.#webDir, "dashboard state directory");
    } else {
      const emptyBloom = Buffer.alloc(this.limits.searchBloomBytes).toString("base64url");
      this.#installRecords(
        head.records.map((inventory) => ({
          inventory,
          cwd: inventory.cwdBasename ?? "(unknown)",
          ownership: { mode: "none" },
          diagnostics: [],
          searchBloom: emptyBloom,
        })),
        true,
      );
      this.#revision = head.revision;
      this.#reconciledAt = head.reconciledAt;
    }
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
    let queryDigest = EMPTY_INVENTORY_QUERY_DIGEST;
    let selected: StoredInventoryRecord[];
    if (isUnfilteredInventoryQuery(query)) {
      selected = this.#orderedRecords.slice(0, limit + 1);
    } else {
      const normalized = normalizeInventoryQuery(query);
      queryDigest = digestJson(normalized);
      const after =
        query.cursor === undefined
          ? undefined
          : decodeInventoryCursor(query.cursor, this.#revision, queryDigest);
      if (after !== undefined) {
        const position = this.#orderedPositions.get(after.inventoryId);
        const record = position === undefined ? undefined : this.#orderedRecords[position];
        if (record === undefined || inventoryActivityAt(record.inventory) !== after.modifiedAt) {
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

      selected = [];
      const start =
        after === undefined
          ? 0
          : (this.#orderedPositions.get(after.inventoryId) ?? -1) + 1;
      let visited = 0;
      const yieldDuringScan = this.#orderedRecords.length > 10_000;
      let lastYieldAt = performance.now();
      for (let index = start; index < this.#orderedRecords.length; index += 1) {
        const record = this.#orderedRecords[index]!;
        if (recordMatches(record, normalized, searchBits, this.limits.searchBloomBytes)) {
          selected.push(record);
          if (selected.length > limit) break;
        }
        visited += 1;
        if (yieldDuringScan && visited % 256 === 0 && performance.now() - lastYieldAt >= 8) {
          await yieldEventLoop();
          lastYieldAt = performance.now();
        }
      }
    }
    const pageRecords = selected.slice(0, limit);
    const page: SessionInventoryPage = {
      sessions: pageRecords.map((record) => cloneInventoryRecord(record.inventory)),
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
        modifiedAt: inventoryActivityAt(pageRecords[pageRecords.length - 1]!.inventory),
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

  /**
   * Persist user-visible recency without rewriting the source file mtime. The
   * inventory ID is preferred; managed session IDs are accepted for attach
   * paths that do not retain the inventory reference.
   */
  markActive(
    sessionRef: string,
    options: { at?: string; activation?: "selected" | "user-turn" | "external-turn" } = {},
  ): Promise<SessionInventoryRecord | undefined> {
    const run = this.#writeTail.then(() => this.#runMarkActive(sessionRef, options));
    this.#writeTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #runMarkActive(
    sessionRef: string,
    options: { at?: string; activation?: "selected" | "user-turn" | "external-turn" },
  ): Promise<SessionInventoryRecord | undefined> {
    await this.initialize();
    await this.#fullIndexPromise;
    const record = this.#records.get(sessionRef) ?? this.#orderedRecords.find(
      (candidate) => candidate.inventory.managed?.sessionId === sessionRef,
    );
    if (record === undefined) return undefined;
    const now = options.at ?? this.#timestamp();
    if (parseTimestamp(now) === undefined) {
      throw new SessionInventoryError("invalid_inventory_activity", "inventory activity timestamp is invalid");
    }
    const currentActivity = inventoryActivityAt(record.inventory);
    const activation = record.inventory.presence.activation === "untouched" ||
      record.inventory.presence.activation === "selected"
      ? options.activation ?? "selected"
      : record.inventory.presence.activation;
    if (now <= currentActivity && activation === record.inventory.presence.activation) {
      return cloneInventoryRecord(record.inventory);
    }
    const updated: StoredInventoryRecord = {
      ...structuredClone(record),
      inventory: {
        ...structuredClone(record.inventory),
        activityAt: now > currentActivity ? now : currentActivity,
        presence: {
          ...structuredClone(record.inventory.presence),
          activation,
        },
      },
    };
    validateStoredRecord(updated, this.limits);
    const records = this.#orderedRecords
      .map((candidate) => candidate.inventory.inventoryId === updated.inventory.inventoryId ? updated : candidate)
      .sort((left, right) => left.inventory.inventoryId.localeCompare(right.inventory.inventoryId));
    const revision = inventoryRevision(records);
    const orderedRecords = [...records].sort(compareStoredRecords);
    const reconciledAt = this.#reconciledAt ?? now;
    const index: PersistedInventoryIndex = {
      formatVersion: SESSION_INVENTORY_FORMAT_VERSION,
      searchKeyDigest: this.#requireSearchKeyDigest(),
      revision,
      builtAt: now,
      reconciledAt,
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
      reconciledAt,
      records: orderedRecords
        .slice(0, DASH_DEFAULT_LIMITS.maxInventoryPageItems + 1)
        .map((candidate) => candidate.inventory),
    };
    await this.#writeSnapshot(index);
    await atomicWritePrivateJson(this.#indexPath, index);
    await atomicWritePrivateBytes(
      this.#headSnapshotPath,
      encodeInventoryHeadSnapshot(head),
    );
    await atomicWritePrivateJson(this.#headPath, head);
    this.#installRecords(orderedRecords, true);
    this.#revision = revision;
    return cloneInventoryRecord(updated.inventory);
  }

  reconcile(): Promise<SessionInventoryReconcileResult> {
    if (this.#reconcilePromise !== undefined) return this.#reconcilePromise;
    const run = this.#writeTail.then(() => this.#runReconcile());
    this.#writeTail = run.then(() => undefined, () => undefined);
    this.#reconcilePromise = run.finally(() => {
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
      await atomicWritePrivateBytes(
        this.#headSnapshotPath,
        encodeInventoryHeadSnapshot(head),
      );
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
          activityAt: latestActivityAt(
            file.modifiedAt,
            catalog?.lastUsedAt,
            this.#records.get(inventoryId)?.inventory.activityAt,
          ),
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
          activityAt: latestActivityAt(
            catalog.updatedAt,
            catalog.lastUsedAt,
            this.#records.get(inventoryId)?.inventory.activityAt,
          ),
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


function latestActivityAt(...values: Array<string | undefined>): string {
  return values.filter((value): value is string => value !== undefined).sort().at(-1)!;
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
