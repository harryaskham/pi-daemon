/**
 * Persisted inventory codecs: hot-head snapshot, full index snapshot, and the
 * JSON fallback validators (bd-5fbf37).
 *
 * Extracted from `session-inventory.ts` with the byte layouts, magic values,
 * version gates, Node-major guard, and fail-closed validation unchanged, so
 * every persisted artifact stays wire-compatible in both directions.
 */

import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { deserialize, serialize } from "node:v8";

import { DASH_DEFAULT_LIMITS } from "./dashboard-contract.js";
import { hasForbiddenExposure, hasForeignPathOwner } from "./path-ownership.js";
import type { SessionInventoryActivation } from "./dashboard-contract.js";
import {
  INVENTORY_HEAD_SNAPSHOT_HEADER_BYTES,
  INVENTORY_HEAD_SNAPSHOT_MAGIC,
  INVENTORY_SNAPSHOT_HEADER_BYTES,
  INVENTORY_SNAPSHOT_MAGIC,
  SESSION_INVENTORY_FORMAT_VERSION,
  SESSION_INVENTORY_SNAPSHOT_VERSION,
  SessionInventoryError,
  isNodeError,
  isRecord,
  parseTimestamp,
  type PersistedInventoryHead,
  type SessionInventoryLimits,
  type PersistedInventoryIndex,
  type StoredInventoryRecord,
} from "./session-inventory-contract.js";

export function encodeInventoryHeadSnapshot(head: PersistedInventoryHead): Buffer {
  const payload = serialize(head);
  const header = Buffer.alloc(INVENTORY_HEAD_SNAPSHOT_HEADER_BYTES);
  INVENTORY_HEAD_SNAPSHOT_MAGIC.copy(header, 0);
  header.writeUInt8(SESSION_INVENTORY_FORMAT_VERSION, 8);
  header.writeUInt8(currentNodeMajor(), 9);
  header.writeUInt32BE(payload.byteLength, 10);
  return Buffer.concat([header, payload]);
}

export function readInventoryHeadSnapshotSync(path: string, maxBytes: number): unknown | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const info = fstatSync(descriptor);
    const getuid = process.getuid;
    if (
      !info.isFile() ||
      hasForeignPathOwner(info.uid, "owner-only", getuid?.()) ||
      hasForbiddenExposure(info.mode, "private")
    ) {
      throw new SessionInventoryError(
        "insecure_inventory_head",
        "inventory hot-head snapshot must be an owner-only regular file",
      );
    }
    if (
      info.size < INVENTORY_HEAD_SNAPSHOT_HEADER_BYTES ||
      info.size > maxBytes + INVENTORY_HEAD_SNAPSHOT_HEADER_BYTES
    ) {
      throw new SessionInventoryError(
        "inventory_head_too_large",
        "inventory hot-head snapshot exceeds byte limit",
      );
    }
    const encoded = readFileSync(descriptor);
    if (
      encoded.byteLength !== info.size ||
      !encoded.subarray(0, 8).equals(INVENTORY_HEAD_SNAPSHOT_MAGIC) ||
      encoded.readUInt8(8) !== SESSION_INVENTORY_FORMAT_VERSION
    ) {
      throw new SessionInventoryError(
        "corrupt_inventory_head",
        "inventory hot-head snapshot header is invalid",
      );
    }
    if (encoded.readUInt8(9) !== currentNodeMajor()) return undefined;
    const payloadBytes = encoded.readUInt32BE(10);
    if (
      payloadBytes < 1 ||
      payloadBytes > maxBytes ||
      payloadBytes !== encoded.byteLength - INVENTORY_HEAD_SNAPSHOT_HEADER_BYTES
    ) {
      throw new SessionInventoryError(
        "corrupt_inventory_head",
        "inventory hot-head snapshot length is invalid",
      );
    }
    return deserialize(encoded.subarray(INVENTORY_HEAD_SNAPSHOT_HEADER_BYTES));
  } finally {
    closeSync(descriptor);
  }
}

export function readInventoryHeadSync(path: string, maxBytes: number): unknown | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) {
      throw new SessionInventoryError(
        "insecure_inventory_head",
        "inventory hot head must be a regular file",
      );
    }
    const getuid = process.getuid;
    if (hasForeignPathOwner(info.uid, "owner-only", getuid?.())) {
      throw new SessionInventoryError(
        "insecure_inventory_head",
        "inventory hot head must be owned by current user",
      );
    }
    if (hasForbiddenExposure(info.mode, "private")) {
      throw new SessionInventoryError(
        "insecure_inventory_head",
        "inventory hot head must be owner-only",
      );
    }
    if (info.size < 1 || info.size > maxBytes) {
      throw new SessionInventoryError(
        "inventory_head_too_large",
        "inventory hot head exceeds byte limit",
      );
    }
    const encoded = readFileSync(descriptor);
    if (encoded.byteLength < 1 || encoded.byteLength > maxBytes) {
      throw new SessionInventoryError(
        "inventory_head_too_large",
        "inventory hot head exceeds byte limit",
      );
    }
    return JSON.parse(encoded.toString("utf8")) as unknown;
  } finally {
    closeSync(descriptor);
  }
}

export function validateInventoryHead(value: unknown): asserts value is PersistedInventoryHead {
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
      (record.activityAt !== undefined && (typeof record.activityAt !== "string" || parseTimestamp(record.activityAt) === undefined)) ||
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

export function encodeInventorySnapshot(
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

export function decodeInventorySnapshot(
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

export function validateSnapshotIndex(
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
      (record.inventory.activityAt !== undefined && (typeof record.inventory.activityAt !== "string" || parseTimestamp(record.inventory.activityAt) === undefined)) ||
      typeof record.inventory.title !== "string"
    ) {
      throw new SessionInventoryError(
        "corrupt_inventory_snapshot",
        "inventory snapshot record is invalid",
      );
    }
  }
}

export function currentNodeMajor(): number {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (!Number.isSafeInteger(major) || major < 1 || major > 255) {
    throw new Error("Node major version cannot be encoded in inventory snapshot");
  }
  return major;
}

export function validatePersistedIndex(
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

export function validateStoredRecord(
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
    (inventory.activityAt !== undefined && (typeof inventory.activityAt !== "string" || parseTimestamp(inventory.activityAt) === undefined)) ||
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

export function validateActivation(value: SessionInventoryActivation): void {
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
