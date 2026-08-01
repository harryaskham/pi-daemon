/**
 * Shared SessionInventory contract: limits, configuration, option/status types,
 * persisted record shapes, the typed error, and the small primitives every
 * inventory internal module needs (bd-5fbf37).
 *
 * `session-inventory.ts` still owns the public `SessionInventory` API and
 * re-exports every name that was previously exported from it, so this split is
 * internal-only: no wire shape, persisted format, or exported surface changes.
 */

import { basename, isAbsolute, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

import { DASH_DEFAULT_LIMITS } from "./dashboard-contract.js";
import type {
  DashboardSourceKind,
  ManagedSessionSummary,
  SessionInventoryActivation,
  SessionInventoryRecord,
  SessionOwnershipInfo,
  SessionSourceFingerprint,
} from "./dashboard-contract.js";
import {
  DEFAULT_PI_DAEMON_WEB_CONFIG,
  type LoadedPiDaemonConfig,
} from "./config.js";
import type { SessionCatalogStore } from "./session-catalog.js";

export const SESSION_INVENTORY_FORMAT_VERSION = 1 as const;
export const SESSION_INVENTORY_SEARCH_KEY_VERSION = 1 as const;
export const SESSION_INVENTORY_SNAPSHOT_VERSION = 1 as const;

export const INVENTORY_SNAPSHOT_MAGIC = Buffer.from("PIDMINV1", "ascii");
export const INVENTORY_SNAPSHOT_HEADER_BYTES = 46;
export const INVENTORY_HEAD_SNAPSHOT_MAGIC = Buffer.from("PIDMHED1", "ascii");
export const INVENTORY_HEAD_SNAPSHOT_HEADER_BYTES = 14;

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

export interface PersistedInventoryIndex {
  formatVersion: typeof SESSION_INVENTORY_FORMAT_VERSION;
  searchKeyDigest: string;
  revision: string;
  builtAt: string;
  reconciledAt: string;
  records: StoredInventoryRecord[];
}

export interface PersistedInventoryHead {
  formatVersion: typeof SESSION_INVENTORY_FORMAT_VERSION;
  revision: string;
  builtAt: string;
  reconciledAt: string;
  records: SessionInventoryRecord[];
}

export interface PersistedSearchKey {
  formatVersion: typeof SESSION_INVENTORY_SEARCH_KEY_VERSION;
  key: string;
}

export interface StoredInventoryRecord {
  inventory: SessionInventoryRecord;
  cwd: string;
  canonicalPath?: string;
  fingerprint?: SessionSourceFingerprint;
  ownership: SessionOwnershipInfo;
  diagnostics: Array<{ code: string; message: string; retryable: boolean }>;
  searchBloom: string;
}

export interface ScannedSessionFile {
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

export interface CandidateSessionFile {
  path: string;
  modifiedMs: number;
  sizeBytes: number;
}

export interface InventoryCursorValue {
  version: 1;
  revision: string;
  queryDigest: string;
  modifiedAt: string;
  inventoryId: string;
}

export class IssueCollector {
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

/** Typed, redaction-safe inventory failure surfaced to callers. */
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

export function normalizeSingleLine(value: string, maxChars: number): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, maxChars);
}
export function cwdBasename(cwd: string): string {
  if (cwd === "(unknown)") return "Unknown project";
  return basename(resolve(cwd)) || cwd;
}
export async function yieldEventLoop(): Promise<void> {
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
}
export async function mapConcurrent<T, R>(
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
export function digestJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("base64url");
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
export function positiveTimestamp(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
export function isWithin(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}
export function inventoryIssueCode(error: unknown): string {
  if (error instanceof SessionInventoryError) return error.code;
  return `inventory_${nodeErrorCode(error) ?? "failure"}`;
}
export function nodeErrorCode(error: unknown): string | undefined {
  return isNodeError(error) && typeof error.code === "string" ? error.code : undefined;
}
export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
