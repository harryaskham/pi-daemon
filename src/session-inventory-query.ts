/**
 * Inventory query normalization, keyed search filtering, cursor codec, and
 * ordering helpers (bd-5fbf37).
 *
 * Extracted from `session-inventory.ts` unchanged: the same bounded filters,
 * the same keyed trigram bloom (whose key never leaves the owner-private state
 * directory), the same opaque revision/query-digest-bound cursors, and the same
 * deterministic ordering.
 */

import { createHash } from "node:crypto";

import { asDashboardCursor } from "./dashboard-contract.js";
import { DASH_DEFAULT_LIMITS } from "./dashboard-contract.js";
import type {
  DashSessionPresence,
  DashboardCursor,
  DashboardSourceKind,
  SessionInventoryQuery,
  SessionInventoryRecord,
} from "./dashboard-contract.js";
import {
  SessionInventoryError,
  digestJson,
  isRecord,
  parseTimestamp,
  type InventoryCursorValue,
  type StoredInventoryRecord,
} from "./session-inventory-contract.js";

export const EMPTY_INVENTORY_QUERY_DIGEST = digestJson({
  search: "",
  sourceKinds: [],
  runtime: [],
});

export function isUnfilteredInventoryQuery(query: SessionInventoryQuery): boolean {
  return (
    query.cursor === undefined &&
    (query.search === undefined || query.search.length === 0) &&
    (query.sourceKinds === undefined || query.sourceKinds.length === 0) &&
    (query.runtime === undefined || query.runtime.length === 0) &&
    query.unread === undefined &&
    query.modifiedAfter === undefined
  );
}

export function normalizeInventoryQuery(query: SessionInventoryQuery): {
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

export function recordMatches(
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

export function buildSearchBloom(value: string, key: Buffer, bytes: number): string {
  const bloom = Buffer.alloc(bytes);
  for (const bit of searchBitPositions(value, key, bytes, 2048)) {
    bloom[bit >> 3] = bloom[bit >> 3]! | (1 << (bit & 7));
  }
  return bloom.toString("base64url");
}

export function searchBitPositions(
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

export function keyedGramHash(value: string, seed: number): number {
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

export function searchBloomMatches(encoded: string, bits: number[], bytes: number): boolean {
  const bloom = Buffer.from(encoded, "base64url");
  if (bloom.length !== bytes) return false;
  return bits.every((bit) => (bloom[bit >> 3]! & (1 << (bit & 7))) !== 0);
}

export function trigrams(value: string): string[] {
  const grams: string[] = [];
  for (let index = 0; index <= value.length - 3; index += 1) {
    grams.push(value.slice(index, index + 3));
  }
  return grams;
}

export function normalizeSearch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
}

export function cloneInventoryRecord(record: SessionInventoryRecord): SessionInventoryRecord {
  return {
    ...record,
    ...(record.managed === undefined ? {} : { managed: { ...record.managed } }),
    activation: {
      ...record.activation,
      modes: [...record.activation.modes],
    },
    presence: {
      ...record.presence,
      ...(record.presence.scheduled === undefined
        ? {}
        : { scheduled: { ...record.presence.scheduled } }),
    },
  };
}

export function compareStoredRecords(left: StoredInventoryRecord, right: StoredInventoryRecord): number {
  return (
    inventoryActivityAt(right.inventory).localeCompare(inventoryActivityAt(left.inventory)) ||
    right.inventory.modifiedAt.localeCompare(left.inventory.modifiedAt) ||
    left.inventory.inventoryId.localeCompare(right.inventory.inventoryId)
  );
}

export function encodeInventoryCursor(value: InventoryCursorValue): DashboardCursor {
  return asDashboardCursor(Buffer.from(JSON.stringify(value), "utf8").toString("base64url"));
}

export function decodeInventoryCursor(
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

export function pageLimit(limit: number, maxSessions: number): number {
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

/** Ordering key: explicit activity when present, otherwise source mtime. */
export function inventoryActivityAt(record: SessionInventoryRecord): string {
  return record.activityAt ?? record.modifiedAt;
}

/** Opaque revision bound to the exact ordered rows a cursor was issued against. */
export function inventoryRevision(records: StoredInventoryRecord[]): string {
  const hash = createHash("sha256");
  for (const record of records) {
    hash.update(record.inventory.inventoryId);
    hash.update("\0");
    hash.update(record.inventory.modifiedAt);
    hash.update("\0");
    hash.update(inventoryActivityAt(record.inventory));
    hash.update("\0");
    hash.update(record.fingerprint?.value ?? "");
    hash.update("\0");
    hash.update(String(record.inventory.managed?.revision ?? ""));
    hash.update("\n");
  }
  return hash.digest("base64url").slice(0, 32);
}
