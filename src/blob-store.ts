import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  open,
  readdir,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import {
  atomicWritePrivateJson,
  encodedSessionId,
  ensurePrivateDirectory,
  readPrivateJsonIfExists,
  stateFileSize,
  validatePrivateFileIfExists,
} from "./durability.js";

export const BLOB_TRANSFER_CONTRACT_VERSION = "1.0" as const;
export const BLOB_STORE_FORMAT_VERSION = 1 as const;

export interface BlobTransferLimits {
  maxBlobs: number;
  maxBlobsPerSession: number;
  maxBlobBytes: number;
  maxTotalBytes: number;
  maxReferences: number;
  maxReferencesPerBlob: number;
  maxNameBytes: number;
  maxMediaTypeBytes: number;
  maxRecordBytes: number;
  maxRecoveryBytes: number;
  reservationTtlMs: number;
  blobTtlMs: number;
  referenceTtlMs: number;
}

export const DEFAULT_BLOB_TRANSFER_LIMITS: Readonly<BlobTransferLimits> = {
  maxBlobs: 256,
  maxBlobsPerSession: 32,
  maxBlobBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxReferences: 512,
  maxReferencesPerBlob: 16,
  maxNameBytes: 512,
  maxMediaTypeBytes: 255,
  maxRecordBytes: 64 * 1024,
  maxRecoveryBytes: 32 * 1024 * 1024,
  reservationTtlMs: 60 * 60 * 1000,
  blobTtlMs: 24 * 60 * 60 * 1000,
  referenceTtlMs: 24 * 60 * 60 * 1000,
};

export interface BlobUntrustedMetadata {
  name: string;
  mediaType: string;
  trust: "untrusted";
}

export type BlobTransferState = "reserved" | "available" | "quarantined";

export interface BlobTransferResource {
  contractVersion: typeof BLOB_TRANSFER_CONTRACT_VERSION;
  blobId: string;
  sessionId: string;
  generation: number;
  revision: number;
  state: BlobTransferState;
  metadata: BlobUntrustedMetadata;
  sizeBytes: number;
  sha256: string;
  referenceCount: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  quarantineCode?: string;
  links: {
    self: string;
    content: string;
    materialize: string;
  };
}

export interface SessionUploadResource {
  contractVersion: typeof BLOB_TRANSFER_CONTRACT_VERSION;
  fileId: string;
  sessionId: string;
  generation: number;
  blobId: string;
  relativeRef: string;
  metadata: BlobUntrustedMetadata;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
  links: {
    self: string;
    content: string;
  };
}

export interface BlobReservationRequest {
  requestId: string;
  expectedGeneration: number;
  metadata: Omit<BlobUntrustedMetadata, "trust">;
  sizeBytes: number;
  sha256: string;
}

export interface BlobMaterializationRequest {
  requestId: string;
  expectedGeneration: number;
  blobId: string;
}

export interface BlobReservationInput {
  blobId: string;
  sessionId: string;
  generation: number;
  metadata: Omit<BlobUntrustedMetadata, "trust">;
  sizeBytes: number;
  sha256: string;
}

export interface SessionUploadInput {
  fileId: string;
  sessionId: string;
  generation: number;
  blobId: string;
}

export interface BlobContentPolicyInput {
  blobId: string;
  sessionId: string;
  generation: number;
  metadata: BlobUntrustedMetadata;
  sizeBytes: number;
  sha256: string;
  /** Owner-private temporary content path. Policies must not execute content. */
  contentPath: string;
}

export type BlobContentPolicyResult =
  | { disposition: "allow" }
  | { disposition: "quarantine"; code: string };

export type BlobContentPolicy = (
  input: Readonly<BlobContentPolicyInput>,
) => Promise<BlobContentPolicyResult> | BlobContentPolicyResult;

const QUARANTINED_ARCHIVE_MEDIA_TYPES = new Set([
  "application/gzip",
  "application/java-archive",
  "application/vnd.android.package-archive",
  "application/x-7z-compressed",
  "application/x-apple-diskimage",
  "application/x-bzip2",
  "application/x-rar-compressed",
  "application/x-tar",
  "application/zip",
]);

const QUARANTINED_ACTIVE_MEDIA_TYPES = new Set([
  "application/javascript",
  "application/vnd.microsoft.portable-executable",
  "application/x-dosexec",
  "application/x-executable",
  "application/x-httpd-php",
  "application/x-sh",
  "application/x-sharedlib",
  "image/svg+xml",
  "text/html",
  "text/javascript",
]);

/**
 * Conservative metadata-only default. Declared MIME remains untrusted and the
 * daemon never parses or executes content. Archives and active/executable types
 * require an explicit operator policy before they leave quarantine.
 */
export const defaultBlobContentPolicy: BlobContentPolicy = ({ metadata }) => {
  if (QUARANTINED_ARCHIVE_MEDIA_TYPES.has(metadata.mediaType)) {
    return { disposition: "quarantine", code: "archive_requires_policy" };
  }
  if (QUARANTINED_ACTIVE_MEDIA_TYPES.has(metadata.mediaType)) {
    return { disposition: "quarantine", code: "active_content_denied" };
  }
  return { disposition: "allow" };
};

export interface BlobTransferRecovery {
  blobs: BlobTransferResource[];
  references: SessionUploadResource[];
  removedExpired: number;
  scannedBytes: number;
}

export interface FileBlobStoreOptions {
  stateDir: string;
  limits?: Partial<BlobTransferLimits>;
  now?: () => Date;
  contentPolicy?: BlobContentPolicy;
}

interface BlobEnvelope {
  formatVersion: typeof BLOB_STORE_FORMAT_VERSION;
  resource: Omit<BlobTransferResource, "referenceCount">;
  uploadIdempotencyKey?: string;
}

interface SessionUploadEnvelope {
  formatVersion: typeof BLOB_STORE_FORMAT_VERSION;
  resource: SessionUploadResource;
}

export class BlobStoreError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
    retryable = false,
  ) {
    super(message);
    this.name = "BlobStoreError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

/**
 * Owner-private opaque transfer storage. Content is never parsed or executed.
 * Metadata remains explicitly untrusted, and session materialization creates a
 * daemon-chosen reference inside the daemon state tree rather than writing to
 * the session cwd or granting a tool/filesystem capability.
 */
export class FileBlobStore {
  readonly rootDir: string;
  /** Secret-free reservation metadata keyed by opaque blob ID. */
  readonly blobsDir: string;
  /** Immutable verified backing objects keyed only by lowercase SHA-256. */
  readonly objectsDir: string;
  readonly inboxesDir: string;
  readonly limits: BlobTransferLimits;
  readonly #now: () => Date;
  readonly #contentPolicy: BlobContentPolicy;
  readonly #blobs = new Map<string, BlobEnvelope>();
  readonly #references = new Map<string, SessionUploadResource>();
  readonly #referencesByBlob = new Map<string, Set<string>>();
  #recovery: Promise<BlobTransferRecovery> | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: FileBlobStoreOptions) {
    if (options.stateDir.length === 0) throw new Error("stateDir must not be empty");
    this.rootDir = join(options.stateDir, "transfers", `v${BLOB_STORE_FORMAT_VERSION}`);
    this.blobsDir = join(this.rootDir, "blobs");
    this.objectsDir = join(this.rootDir, "objects");
    this.inboxesDir = join(this.rootDir, "session-inboxes");
    this.limits = resolveLimits(options.limits);
    this.#now = options.now ?? (() => new Date());
    this.#contentPolicy = options.contentPolicy ?? defaultBlobContentPolicy;
  }

  get capabilities(): {
    contractVersion: typeof BLOB_TRANSFER_CONTRACT_VERSION;
    opaqueContent: true;
    contentAddressedSha256: true;
    untrustedMetadata: true;
    cwdMaterialization: false;
    quarantine: true;
    limits: BlobTransferLimits;
  } {
    return {
      contractVersion: BLOB_TRANSFER_CONTRACT_VERSION,
      opaqueContent: true,
      contentAddressedSha256: true,
      untrustedMetadata: true,
      cwdMaterialization: false,
      quarantine: true,
      limits: { ...this.limits },
    };
  }

  recover(): Promise<BlobTransferRecovery> {
    this.#recovery ??= this.#load();
    return this.#recovery.then((value) => structuredClone(value));
  }

  async reserve(input: BlobReservationInput): Promise<BlobTransferResource> {
    await this.recover();
    return this.#serialize(async () => {
      await this.#pruneLocked();
      const normalized = reservation(input, this.limits);
      const existing = this.#blobs.get(normalized.blobId);
      if (existing !== undefined) {
        if (!sameReservation(existing.resource, normalized)) {
          throw new BlobStoreError(
            "blob_reservation_conflict",
            "blob reservation already exists with different metadata",
          );
        }
        return this.#publicBlob(existing);
      }
      const digestAlias = [...this.#blobs.values()].find(
        ({ resource }) => resource.sha256 === normalized.sha256,
      );
      if (
        digestAlias !== undefined &&
        digestAlias.resource.sizeBytes !== normalized.sizeBytes
      ) {
        throw new BlobStoreError(
          "blob_reservation_conflict",
          "blob aliases for one SHA-256 must declare the same size",
        );
      }
      if (this.#blobs.size >= this.limits.maxBlobs) {
        throw new BlobStoreError("blob_capacity", "blob count quota is exhausted");
      }
      const perSession = [...this.#blobs.values()].filter(
        ({ resource }) => resource.sessionId === normalized.sessionId,
      ).length;
      if (perSession >= this.limits.maxBlobsPerSession) {
        throw new BlobStoreError("blob_capacity", "per-session blob quota is exhausted");
      }
      const declaredObjects = new Map<string, number>();
      for (const { resource } of this.#blobs.values()) {
        declaredObjects.set(resource.sha256, resource.sizeBytes);
      }
      const reservedBytes = [...declaredObjects.values()].reduce(
        (sum, sizeBytes) => sum + sizeBytes,
        0,
      );
      const additionalBytes = declaredObjects.has(normalized.sha256)
        ? 0
        : normalized.sizeBytes;
      if (reservedBytes + additionalBytes > this.limits.maxTotalBytes) {
        throw new BlobStoreError("blob_capacity", "blob byte quota is exhausted");
      }
      const timestamp = this.#timestamp();
      const resource: Omit<BlobTransferResource, "referenceCount"> = {
        contractVersion: BLOB_TRANSFER_CONTRACT_VERSION,
        blobId: normalized.blobId,
        sessionId: normalized.sessionId,
        generation: normalized.generation,
        revision: 0,
        state: "reserved",
        metadata: normalized.metadata,
        sizeBytes: normalized.sizeBytes,
        sha256: normalized.sha256,
        createdAt: timestamp,
        updatedAt: timestamp,
        expiresAt: this.#expires(this.limits.reservationTtlMs),
        links: blobLinks(normalized.sessionId, normalized.blobId),
      };
      const envelope: BlobEnvelope = {
        formatVersion: BLOB_STORE_FORMAT_VERSION,
        resource,
      };
      await this.#writeBlob(envelope);
      this.#blobs.set(resource.blobId, envelope);
      return this.#publicBlob(envelope);
    });
  }

  async getBlob(
    blobId: string,
    sessionId: string,
    generation: number,
  ): Promise<BlobTransferResource | undefined> {
    await this.recover();
    return this.#serialize(async () => {
      await this.#pruneLocked();
      const envelope = this.#blobs.get(blobIdentifier(blobId));
      if (envelope === undefined) return undefined;
      assertBinding(envelope.resource, sessionId, generation);
      return this.#publicBlob(envelope);
    });
  }

  async uploadContent(
    blobId: string,
    sessionId: string,
    generation: number,
    idempotencyKey: string,
    content: AsyncIterable<Uint8Array>,
  ): Promise<BlobTransferResource> {
    await this.recover();
    return this.#serialize(async () => {
      await this.#pruneLocked();
      const id = blobIdentifier(blobId);
      const envelope = this.#blobs.get(id);
      if (envelope === undefined) throw new BlobStoreError("blob_not_found", "blob not found");
      assertBinding(envelope.resource, sessionId, generation);
      const key = boundedIdentifier(idempotencyKey, "idempotency key", 512);
      if (
        envelope.uploadIdempotencyKey !== undefined &&
        envelope.uploadIdempotencyKey !== key
      ) {
        throw new BlobStoreError(
          "idempotency_conflict",
          "blob content upload uses a different idempotency key",
        );
      }
      if (envelope.resource.state !== "reserved") {
        if (envelope.uploadIdempotencyKey !== key) {
          throw new BlobStoreError("idempotency_conflict", "blob content is already settled");
        }
        return this.#publicBlob(envelope);
      }
      if (Date.parse(envelope.resource.expiresAt) <= this.#nowMs()) {
        throw new BlobStoreError("blob_expired", "blob reservation expired");
      }
      envelope.uploadIdempotencyKey = key;
      await this.#writeBlob(envelope);

      const temporary = join(
        this.objectsDir,
        `.${envelope.resource.sha256}.upload-${process.pid}-${randomUUID()}`,
      );
      const handle = await open(temporary, "wx", 0o600);
      let sizeBytes = 0;
      const digest = createHash("sha256");
      try {
        for await (const value of content) {
          const chunk = Buffer.from(value);
          sizeBytes += chunk.length;
          if (sizeBytes > envelope.resource.sizeBytes || sizeBytes > this.limits.maxBlobBytes) {
            throw new BlobStoreError("blob_size_mismatch", "blob content exceeds reserved size");
          }
          digest.update(chunk);
          await writeAll(handle, chunk);
        }
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => {});
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      await handle.close();
      const sha256 = digest.digest("hex");
      if (sizeBytes !== envelope.resource.sizeBytes || sha256 !== envelope.resource.sha256) {
        await rm(temporary, { force: true });
        throw new BlobStoreError(
          sizeBytes !== envelope.resource.sizeBytes ? "blob_size_mismatch" : "blob_hash_mismatch",
          "blob content does not match the reservation",
        );
      }

      let policy: BlobContentPolicyResult;
      try {
        policy = await this.#contentPolicy({
          blobId: envelope.resource.blobId,
          sessionId: envelope.resource.sessionId,
          generation: envelope.resource.generation,
          metadata: structuredClone(envelope.resource.metadata),
          sizeBytes,
          sha256,
          contentPath: temporary,
        });
        validatePolicyResult(policy);
      } catch {
        policy = { disposition: "quarantine", code: "content_policy_error" };
      }
      const contentPath = this.#objectContentPath(sha256);
      if ((await stateFileSize(contentPath)) === undefined) {
        await rename(temporary, contentPath);
        await chmod(contentPath, 0o400);
        await syncDirectory(this.objectsDir);
      } else {
        await validateContentObject(contentPath, sha256, sizeBytes);
        await rm(temporary, { force: true });
      }
      envelope.resource.state =
        policy.disposition === "allow" ? "available" : "quarantined";
      envelope.resource.revision += 1;
      envelope.resource.updatedAt = this.#timestamp();
      envelope.resource.expiresAt = this.#expires(this.limits.blobTtlMs);
      if (policy.disposition === "quarantine") {
        envelope.resource.quarantineCode = policyCode(policy.code);
      } else {
        delete envelope.resource.quarantineCode;
      }
      await this.#writeBlob(envelope);
      return this.#publicBlob(envelope);
    });
  }

  async blobContent(
    blobId: string,
    sessionId: string,
    generation: number,
  ): Promise<{ resource: BlobTransferResource; path: string }> {
    await this.recover();
    return this.#serialize(async () => {
      await this.#pruneLocked();
      const envelope = this.#blobs.get(blobIdentifier(blobId));
      if (envelope === undefined) throw new BlobStoreError("blob_not_found", "blob not found");
      assertBinding(envelope.resource, sessionId, generation);
      if (envelope.resource.state === "quarantined") {
        throw new BlobStoreError("blob_quarantined", "blob content is quarantined");
      }
      if (envelope.resource.state !== "available") {
        throw new BlobStoreError("blob_not_ready", "blob content is not available", undefined, true);
      }
      const path = this.#objectContentPath(envelope.resource.sha256);
      await validateContentObject(path, envelope.resource.sha256, envelope.resource.sizeBytes);
      return {
        resource: this.#publicBlob(envelope),
        path,
      };
    });
  }

  async materialize(input: SessionUploadInput): Promise<SessionUploadResource> {
    await this.recover();
    return this.#serialize(async () => {
      await this.#pruneLocked();
      const normalized = uploadInput(input);
      const existing = this.#references.get(normalized.fileId);
      if (existing !== undefined) {
        if (!sameUpload(existing, normalized)) {
          throw new BlobStoreError(
            "file_reference_conflict",
            "session upload reference already exists with different content",
          );
        }
        return structuredClone(existing);
      }
      const blob = this.#blobs.get(normalized.blobId);
      if (blob === undefined) throw new BlobStoreError("blob_not_found", "blob not found");
      assertBinding(blob.resource, normalized.sessionId, normalized.generation);
      if (blob.resource.state === "quarantined") {
        throw new BlobStoreError("blob_quarantined", "blob content is quarantined");
      }
      if (blob.resource.state !== "available") {
        throw new BlobStoreError("blob_not_ready", "blob content is not available", undefined, true);
      }
      if (Date.parse(blob.resource.expiresAt) <= this.#nowMs()) {
        throw new BlobStoreError("blob_expired", "blob expired before materialization");
      }
      if (this.#references.size >= this.limits.maxReferences) {
        throw new BlobStoreError("blob_reference_capacity", "session upload reference quota is exhausted");
      }
      const references = this.#referencesByBlob.get(blob.resource.blobId);
      if ((references?.size ?? 0) >= this.limits.maxReferencesPerBlob) {
        throw new BlobStoreError("blob_reference_capacity", "per-blob reference quota is exhausted");
      }

      const directory = await this.#inboxDirectory(
        normalized.sessionId,
        normalized.generation,
      );
      const contentPath = join(directory, `${normalized.fileId}.bin`);
      await link(this.#objectContentPath(blob.resource.sha256), contentPath).catch((error: unknown) => {
        throw nodeStoreError(error, "file_reference_conflict", "session upload reference content already exists");
      });
      await chmod(contentPath, 0o400);
      const timestamp = this.#timestamp();
      const resource: SessionUploadResource = {
        contractVersion: BLOB_TRANSFER_CONTRACT_VERSION,
        fileId: normalized.fileId,
        sessionId: normalized.sessionId,
        generation: normalized.generation,
        blobId: normalized.blobId,
        relativeRef: `uploads/${normalized.fileId}`,
        metadata: structuredClone(blob.resource.metadata),
        sizeBytes: blob.resource.sizeBytes,
        sha256: blob.resource.sha256,
        createdAt: timestamp,
        expiresAt: this.#expires(this.limits.referenceTtlMs),
        links: uploadLinks(normalized.sessionId, normalized.fileId),
      };
      try {
        await atomicWritePrivateJson(join(directory, `${resource.fileId}.json`), {
          formatVersion: BLOB_STORE_FORMAT_VERSION,
          resource,
        } satisfies SessionUploadEnvelope);
        await syncDirectory(directory);
      } catch (error) {
        await rm(contentPath, { force: true }).catch(() => {});
        throw error;
      }
      this.#references.set(resource.fileId, resource);
      this.#referenceSet(resource.blobId).add(resource.fileId);
      return structuredClone(resource);
    });
  }

  async getReference(
    fileId: string,
    sessionId: string,
    generation: number,
  ): Promise<SessionUploadResource | undefined> {
    await this.recover();
    return this.#serialize(async () => {
      await this.#pruneLocked();
      const resource = this.#references.get(fileIdentifier(fileId));
      if (resource === undefined) return undefined;
      assertBinding(resource, sessionId, generation);
      return structuredClone(resource);
    });
  }

  async referenceContent(
    fileId: string,
    sessionId: string,
    generation: number,
  ): Promise<{ resource: SessionUploadResource; path: string }> {
    await this.recover();
    return this.#serialize(async () => {
      await this.#pruneLocked();
      const resource = this.#references.get(fileIdentifier(fileId));
      if (resource === undefined) {
        throw new BlobStoreError("file_reference_not_found", "session upload reference not found");
      }
      assertBinding(resource, sessionId, generation);
      const path = this.#referenceContentPath(resource);
      await validateContentObject(path, resource.sha256, resource.sizeBytes);
      return { resource: structuredClone(resource), path };
    });
  }

  async deleteBlob(blobId: string, sessionId: string, generation: number): Promise<boolean> {
    await this.recover();
    return this.#serialize(async () => {
      const envelope = this.#blobs.get(blobIdentifier(blobId));
      if (envelope === undefined) return false;
      assertBinding(envelope.resource, sessionId, generation);
      if ((this.#referencesByBlob.get(envelope.resource.blobId)?.size ?? 0) > 0) {
        throw new BlobStoreError("blob_in_use", "blob still has session upload references");
      }
      await this.#removeBlob(envelope.resource.blobId);
      return true;
    });
  }

  async deleteReference(
    fileId: string,
    sessionId: string,
    generation: number,
  ): Promise<boolean> {
    await this.recover();
    return this.#serialize(async () => {
      const resource = this.#references.get(fileIdentifier(fileId));
      if (resource === undefined) return false;
      assertBinding(resource, sessionId, generation);
      await this.#removeReference(resource);
      await this.#pruneLocked();
      return true;
    });
  }

  async deleteGeneration(sessionId: string, generation: number): Promise<number> {
    await this.recover();
    return this.#serialize(async () => {
      let removed = 0;
      for (const resource of [...this.#references.values()]) {
        if (resource.sessionId === sessionId && resource.generation === generation) {
          await this.#removeReference(resource);
          removed += 1;
        }
      }
      for (const { resource } of [...this.#blobs.values()]) {
        if (
          resource.sessionId === sessionId &&
          resource.generation === generation &&
          (this.#referencesByBlob.get(resource.blobId)?.size ?? 0) === 0
        ) {
          await this.#removeBlob(resource.blobId);
          removed += 1;
        }
      }
      return removed;
    });
  }

  async prune(): Promise<number> {
    await this.recover();
    return this.#serialize(() => this.#pruneLocked());
  }

  async #load(): Promise<BlobTransferRecovery> {
    await ensurePrivateDirectory(join(this.rootDir, "..", ".."), "daemon state directory");
    await ensurePrivateDirectory(join(this.rootDir, ".."), "transfer state directory");
    await ensurePrivateDirectory(this.rootDir, "versioned transfer state directory");
    await ensurePrivateDirectory(this.blobsDir, "blob state directory");
    await ensurePrivateDirectory(this.objectsDir, "content-addressed object directory");
    await ensurePrivateDirectory(this.inboxesDir, "session upload inbox directory");
    let scannedBytes = 0;

    const blobEntries = await readdir(this.blobsDir, { withFileTypes: true });
    if (blobEntries.length > this.limits.maxBlobs * 4 + 64) {
      throw new BlobStoreError("blob_recovery_limit", "blob state entry count exceeds recovery limit");
    }
    for (const entry of blobEntries) {
      const path = join(this.blobsDir, entry.name);
      if (entry.name.includes(".tmp-") || entry.name.includes(".upload-")) {
        await rm(path, { force: true });
        continue;
      }
      const match = /^(blob-[A-Za-z0-9_-]{43})\.json$/u.exec(entry.name);
      if (match === null) continue;
      await validatePrivateFileIfExists(path, "blob state file");
      const size = await stateFileSize(path) ?? 0;
      scannedBytes += size;
      if (size > this.limits.maxRecordBytes || scannedBytes > this.limits.maxRecoveryBytes) {
        throw new BlobStoreError("blob_recovery_limit", "blob state exceeds recovery byte limit");
      }
      const envelope = validateBlobEnvelope(await readPrivateJsonIfExists(path), this.limits);
      if (envelope.resource.blobId !== match[1] || this.#blobs.has(match[1])) {
        throw new BlobStoreError("corrupt_blob_state", "blob state identity is invalid");
      }
      this.#blobs.set(match[1], envelope);
    }
    if (this.#blobs.size > this.limits.maxBlobs) {
      throw new BlobStoreError("blob_capacity", "persisted blob count exceeds capacity");
    }

    await this.#loadReferences((bytes) => {
      scannedBytes += bytes;
      if (scannedBytes > this.limits.maxRecoveryBytes) {
        throw new BlobStoreError("blob_recovery_limit", "transfer state exceeds recovery byte limit");
      }
    });
    for (const [blobId, references] of this.#referencesByBlob) {
      if (!this.#blobs.has(blobId)) {
        throw new BlobStoreError("corrupt_blob_state", "session upload references a missing blob");
      }
      if (references.size > this.limits.maxReferencesPerBlob) {
        throw new BlobStoreError("blob_reference_capacity", "persisted per-blob reference count exceeds capacity");
      }
    }

    const expectedObjects = new Map<string, number>();
    for (const { resource } of this.#blobs.values()) {
      if (resource.state === "reserved") continue;
      const previousSize = expectedObjects.get(resource.sha256);
      if (previousSize !== undefined && previousSize !== resource.sizeBytes) {
        throw new BlobStoreError(
          "corrupt_blob_state",
          "content-addressed aliases disagree about object size",
        );
      }
      expectedObjects.set(resource.sha256, resource.sizeBytes);
    }
    const objectEntries = await readdir(this.objectsDir, { withFileTypes: true });
    if (objectEntries.length > this.limits.maxBlobs * 2 + 64) {
      throw new BlobStoreError(
        "blob_recovery_limit",
        "content-addressed object entry count exceeds recovery limit",
      );
    }
    const recoveredObjects = new Set<string>();
    for (const entry of objectEntries) {
      const path = join(this.objectsDir, entry.name);
      if (entry.name.includes(".tmp-") || entry.name.includes(".upload-")) {
        await rm(path, { force: true });
        continue;
      }
      const match = /^([a-f0-9]{64})\.bin$/u.exec(entry.name);
      if (match === null || !entry.isFile()) {
        throw new BlobStoreError(
          "corrupt_blob_state",
          "content-addressed object directory contains an invalid entry",
        );
      }
      const sha256 = match[1]!;
      const expectedBytes = expectedObjects.get(sha256);
      if (expectedBytes === undefined) {
        await rm(path, { force: true });
        continue;
      }
      await validateContentObject(path, sha256, expectedBytes);
      scannedBytes += expectedBytes;
      if (scannedBytes > this.limits.maxRecoveryBytes) {
        throw new BlobStoreError(
          "blob_recovery_limit",
          "transfer state exceeds recovery byte limit",
        );
      }
      recoveredObjects.add(sha256);
    }
    if ([...expectedObjects.keys()].some((sha256) => !recoveredObjects.has(sha256))) {
      throw new BlobStoreError(
        "corrupt_blob_state",
        "settled blob references a missing content-addressed object",
      );
    }
    const declaredObjects = new Map<string, number>();
    for (const { resource } of this.#blobs.values()) {
      const previousSize = declaredObjects.get(resource.sha256);
      if (previousSize !== undefined && previousSize !== resource.sizeBytes) {
        throw new BlobStoreError(
          "corrupt_blob_state",
          "blob aliases for one SHA-256 disagree about declared size",
        );
      }
      declaredObjects.set(resource.sha256, resource.sizeBytes);
    }
    const reservedBytes = [...declaredObjects.values()].reduce(
      (sum, sizeBytes) => sum + sizeBytes,
      0,
    );
    if (reservedBytes > this.limits.maxTotalBytes) {
      throw new BlobStoreError("blob_capacity", "persisted blob bytes exceed capacity");
    }
    const removedExpired = await this.#pruneLocked();
    return {
      blobs: [...this.#blobs.values()]
        .map((value) => this.#publicBlob(value))
        .sort((left, right) => left.blobId.localeCompare(right.blobId)),
      references: [...this.#references.values()]
        .map((value) => structuredClone(value))
        .sort((left, right) => left.fileId.localeCompare(right.fileId)),
      removedExpired,
      scannedBytes,
    };
  }

  async #loadReferences(addBytes: (bytes: number) => void): Promise<void> {
    const sessionDirectories = await readdir(this.inboxesDir, { withFileTypes: true });
    if (sessionDirectories.length > this.limits.maxReferences) {
      throw new BlobStoreError("blob_reference_capacity", "session inbox count exceeds capacity");
    }
    for (const sessionEntry of sessionDirectories) {
      if (!sessionEntry.isDirectory() || !/^s-[A-Za-z0-9_-]+$/u.test(sessionEntry.name)) continue;
      const sessionDirectory = join(this.inboxesDir, sessionEntry.name);
      await ensurePrivateDirectory(sessionDirectory, "session upload directory");
      const generations = await readdir(sessionDirectory, { withFileTypes: true });
      for (const generationEntry of generations) {
        const generationMatch = /^g-(\d+)$/u.exec(generationEntry.name);
        if (!generationEntry.isDirectory() || generationMatch === null) continue;
        const generationDirectory = join(sessionDirectory, generationEntry.name);
        await ensurePrivateDirectory(generationDirectory, "session generation upload directory");
        const entries = await readdir(generationDirectory, { withFileTypes: true });
        const loadedFileIds = new Set<string>();
        if (entries.length > this.limits.maxReferences * 3 + 32) {
          throw new BlobStoreError("blob_recovery_limit", "session inbox entry count exceeds recovery limit");
        }
        for (const entry of entries) {
          const match = /^(file-[A-Za-z0-9_-]{43})\.json$/u.exec(entry.name);
          if (match === null) continue;
          const path = join(generationDirectory, entry.name);
          await validatePrivateFileIfExists(path, "session upload state file");
          const size = await stateFileSize(path) ?? 0;
          if (size > this.limits.maxRecordBytes) {
            throw new BlobStoreError("blob_recovery_limit", "session upload record exceeds byte limit");
          }
          addBytes(size);
          const envelope = validateUploadEnvelope(await readPrivateJsonIfExists(path), this.limits);
          const resource = envelope.resource;
          if (
            resource.fileId !== match[1] ||
            encodedSessionId(resource.sessionId) !== sessionEntry.name ||
            resource.generation !== Number(generationMatch[1]) ||
            this.#references.has(resource.fileId)
          ) {
            throw new BlobStoreError("corrupt_blob_state", "session upload identity is invalid");
          }
          await validateContentObject(
            join(generationDirectory, `${resource.fileId}.bin`),
            resource.sha256,
            resource.sizeBytes,
          );
          this.#references.set(resource.fileId, resource);
          loadedFileIds.add(resource.fileId);
          this.#referenceSet(resource.blobId).add(resource.fileId);
          if (this.#references.size > this.limits.maxReferences) {
            throw new BlobStoreError("blob_reference_capacity", "persisted reference count exceeds capacity");
          }
        }
        for (const entry of entries) {
          const content = /^(file-[A-Za-z0-9_-]{43})\.bin$/u.exec(entry.name);
          if (content !== null && !loadedFileIds.has(content[1]!)) {
            await rm(join(generationDirectory, entry.name), { force: true });
          } else if (entry.name.includes(".tmp-")) {
            await rm(join(generationDirectory, entry.name), { force: true });
          }
        }
      }
    }
  }

  async #pruneLocked(): Promise<number> {
    const now = this.#nowMs();
    let removed = 0;
    for (const resource of [...this.#references.values()]) {
      if (Date.parse(resource.expiresAt) <= now) {
        await this.#removeReference(resource);
        removed += 1;
      }
    }
    for (const { resource } of [...this.#blobs.values()]) {
      if (
        Date.parse(resource.expiresAt) <= now &&
        (this.#referencesByBlob.get(resource.blobId)?.size ?? 0) === 0
      ) {
        await this.#removeBlob(resource.blobId);
        removed += 1;
      }
    }
    return removed;
  }

  async #removeBlob(blobId: string): Promise<void> {
    const envelope = this.#blobs.get(blobId);
    await rm(this.#blobManifestPath(blobId), { force: true });
    this.#blobs.delete(blobId);
    this.#referencesByBlob.delete(blobId);
    if (
      envelope !== undefined &&
      envelope.resource.state !== "reserved" &&
      ![...this.#blobs.values()].some(
        ({ resource }) =>
          resource.state !== "reserved" &&
          resource.sha256 === envelope.resource.sha256,
      )
    ) {
      await rm(this.#objectContentPath(envelope.resource.sha256), { force: true });
    }
  }

  async #removeReference(resource: SessionUploadResource): Promise<void> {
    const directory = await this.#inboxDirectory(resource.sessionId, resource.generation);
    await rm(join(directory, `${resource.fileId}.json`), { force: true });
    await rm(join(directory, `${resource.fileId}.bin`), { force: true });
    this.#references.delete(resource.fileId);
    const references = this.#referencesByBlob.get(resource.blobId);
    references?.delete(resource.fileId);
    if (references?.size === 0) this.#referencesByBlob.delete(resource.blobId);
  }

  async #writeBlob(envelope: BlobEnvelope): Promise<void> {
    await atomicWritePrivateJson(this.#blobManifestPath(envelope.resource.blobId), envelope);
  }

  #publicBlob(envelope: BlobEnvelope): BlobTransferResource {
    return {
      ...structuredClone(envelope.resource),
      referenceCount: this.#referencesByBlob.get(envelope.resource.blobId)?.size ?? 0,
    };
  }

  #referenceSet(blobId: string): Set<string> {
    let references = this.#referencesByBlob.get(blobId);
    if (references === undefined) {
      references = new Set<string>();
      this.#referencesByBlob.set(blobId, references);
    }
    return references;
  }

  #blobManifestPath(blobId: string): string {
    return join(this.blobsDir, `${blobIdentifier(blobId)}.json`);
  }

  #objectContentPath(sha256: string): string {
    return join(this.objectsDir, `${sha256Digest(sha256)}.bin`);
  }

  async #inboxDirectory(sessionId: string, generation: number): Promise<string> {
    const directory = join(
      this.inboxesDir,
      encodedSessionId(boundedIdentifier(sessionId, "session ID", 256)),
      `g-${nonNegativeInteger(generation, "generation")}`,
    );
    await ensurePrivateDirectory(directory, "session upload inbox");
    return directory;
  }

  #referenceContentPath(resource: SessionUploadResource): string {
    return join(
      this.inboxesDir,
      encodedSessionId(resource.sessionId),
      `g-${resource.generation}`,
      `${resource.fileId}.bin`,
    );
  }

  #timestamp(): string {
    return this.#date().toISOString();
  }

  #expires(ttlMs: number): string {
    return new Date(this.#nowMs() + ttlMs).toISOString();
  }

  #date(): Date {
    const value = this.#now();
    if (!Number.isFinite(value.getTime())) throw new Error("now returned an invalid date");
    return value;
  }

  #nowMs(): number {
    return this.#date().getTime();
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function blobIdForScope(scope: string): string {
  const digest = createHash("sha256").update(scope, "utf8").digest("base64url");
  return `blob-${digest.slice(0, 43)}`;
}

export function fileIdForScope(scope: string): string {
  const digest = createHash("sha256").update(scope, "utf8").digest("base64url");
  return `file-${digest.slice(0, 43)}`;
}

export function contentReadStream(path: string): ReturnType<typeof createReadStream> {
  return createReadStream(path);
}

function resolveLimits(overrides: Partial<BlobTransferLimits> | undefined): BlobTransferLimits {
  const limits = { ...DEFAULT_BLOB_TRANSFER_LIMITS, ...(overrides ?? {}) };
  for (const field of [
    "maxBlobs",
    "maxBlobsPerSession",
    "maxBlobBytes",
    "maxTotalBytes",
    "maxReferences",
    "maxReferencesPerBlob",
    "maxNameBytes",
    "maxMediaTypeBytes",
    "maxRecordBytes",
    "maxRecoveryBytes",
  ] as const) {
    limits[field] = positiveInteger(limits[field], field);
  }
  for (const field of ["reservationTtlMs", "blobTtlMs", "referenceTtlMs"] as const) {
    limits[field] = nonNegativeInteger(limits[field], field);
  }
  if (limits.maxBlobsPerSession > limits.maxBlobs) {
    throw new Error("maxBlobsPerSession cannot exceed maxBlobs");
  }
  if (limits.maxReferencesPerBlob > limits.maxReferences) {
    throw new Error("maxReferencesPerBlob cannot exceed maxReferences");
  }
  if (limits.maxBlobBytes > limits.maxTotalBytes) {
    throw new Error("maxBlobBytes cannot exceed maxTotalBytes");
  }
  return limits;
}

function reservation(
  input: BlobReservationInput,
  limits: BlobTransferLimits,
): BlobReservationInput & { metadata: BlobUntrustedMetadata } {
  const name = metadataName(input.metadata.name, limits.maxNameBytes);
  const mediaType = metadataMediaType(input.metadata.mediaType, limits.maxMediaTypeBytes);
  const sizeBytes = nonNegativeInteger(input.sizeBytes, "sizeBytes");
  if (sizeBytes > limits.maxBlobBytes) {
    throw new BlobStoreError("blob_too_large", "blob size exceeds per-blob limit");
  }
  return {
    blobId: blobIdentifier(input.blobId),
    sessionId: boundedIdentifier(input.sessionId, "session ID", 256),
    generation: nonNegativeInteger(input.generation, "generation"),
    metadata: { name, mediaType, trust: "untrusted" },
    sizeBytes,
    sha256: sha256Digest(input.sha256),
  };
}

function uploadInput(input: SessionUploadInput): SessionUploadInput {
  return {
    fileId: fileIdentifier(input.fileId),
    sessionId: boundedIdentifier(input.sessionId, "session ID", 256),
    generation: nonNegativeInteger(input.generation, "generation"),
    blobId: blobIdentifier(input.blobId),
  };
}

function sameReservation(
  current: Omit<BlobTransferResource, "referenceCount">,
  next: BlobReservationInput & { metadata: BlobUntrustedMetadata },
): boolean {
  return (
    current.blobId === next.blobId &&
    current.sessionId === next.sessionId &&
    current.generation === next.generation &&
    current.metadata.name === next.metadata.name &&
    current.metadata.mediaType === next.metadata.mediaType &&
    current.sizeBytes === next.sizeBytes &&
    current.sha256 === next.sha256
  );
}

function sameUpload(current: SessionUploadResource, next: SessionUploadInput): boolean {
  return (
    current.fileId === next.fileId &&
    current.sessionId === next.sessionId &&
    current.generation === next.generation &&
    current.blobId === next.blobId
  );
}

function assertBinding(
  resource: { sessionId: string; generation: number },
  sessionId: string,
  generation: number,
): void {
  if (resource.sessionId !== sessionId || resource.generation !== generation) {
    throw new BlobStoreError(
      "blob_session_precondition_failed",
      "blob or upload reference belongs to a different session generation",
    );
  }
}

function blobLinks(sessionId: string, blobId: string): BlobTransferResource["links"] {
  const session = encodeURIComponent(sessionId);
  const blob = encodeURIComponent(blobId);
  return {
    self: `/v1/session/${session}/blob/${blob}`,
    content: `/v1/session/${session}/blob/${blob}/content`,
    materialize: `/v1/session/${session}/file`,
  };
}

function uploadLinks(sessionId: string, fileId: string): SessionUploadResource["links"] {
  const session = encodeURIComponent(sessionId);
  const file = encodeURIComponent(fileId);
  return {
    self: `/v1/session/${session}/file/${file}`,
    content: `/v1/session/${session}/file/${file}/content`,
  };
}

function validateBlobEnvelope(value: unknown, limits: BlobTransferLimits): BlobEnvelope {
  if (!isRecord(value) || value.formatVersion !== BLOB_STORE_FORMAT_VERSION) {
    throw new BlobStoreError("corrupt_blob_state", "blob state format is invalid");
  }
  const resource = validateBlobResource(value.resource, limits);
  if (
    value.uploadIdempotencyKey !== undefined &&
    typeof value.uploadIdempotencyKey !== "string"
  ) {
    throw new BlobStoreError("corrupt_blob_state", "blob upload idempotency key is invalid");
  }
  const uploadIdempotencyKey =
    typeof value.uploadIdempotencyKey === "string"
      ? boundedIdentifier(value.uploadIdempotencyKey, "idempotency key", 512)
      : undefined;
  return {
    formatVersion: BLOB_STORE_FORMAT_VERSION,
    resource: omitReferenceCount(resource),
    ...(uploadIdempotencyKey === undefined ? {} : { uploadIdempotencyKey }),
  };
}

function validateUploadEnvelope(value: unknown, limits: BlobTransferLimits): SessionUploadEnvelope {
  if (!isRecord(value) || value.formatVersion !== BLOB_STORE_FORMAT_VERSION) {
    throw new BlobStoreError("corrupt_blob_state", "session upload state format is invalid");
  }
  return {
    formatVersion: BLOB_STORE_FORMAT_VERSION,
    resource: validateUploadResource(value.resource, limits),
  };
}

function validateBlobResource(value: unknown, limits: BlobTransferLimits): BlobTransferResource {
  if (!isRecord(value)) throw new BlobStoreError("corrupt_blob_state", "blob resource is invalid");
  const parsed = reservation(
    {
      blobId: value.blobId as string,
      sessionId: value.sessionId as string,
      generation: value.generation as number,
      metadata: isRecord(value.metadata)
        ? { name: value.metadata.name as string, mediaType: value.metadata.mediaType as string }
        : { name: "", mediaType: "" },
      sizeBytes: value.sizeBytes as number,
      sha256: value.sha256 as string,
    },
    limits,
  );
  if (
    value.contractVersion !== BLOB_TRANSFER_CONTRACT_VERSION ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !["reserved", "available", "quarantined"].includes(value.state as string) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !isTimestamp(value.expiresAt) ||
    !isRecord(value.links) ||
    JSON.stringify(value.links) !== JSON.stringify(blobLinks(parsed.sessionId, parsed.blobId)) ||
    (value.state === "quarantined" && typeof value.quarantineCode !== "string") ||
    (value.state !== "quarantined" && value.quarantineCode !== undefined)
  ) {
    throw new BlobStoreError("corrupt_blob_state", "blob resource is invalid");
  }
  return {
    contractVersion: BLOB_TRANSFER_CONTRACT_VERSION,
    ...parsed,
    revision: value.revision as number,
    state: value.state as BlobTransferState,
    referenceCount: 0,
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
    expiresAt: value.expiresAt as string,
    ...(value.quarantineCode === undefined
      ? {}
      : { quarantineCode: policyCode(value.quarantineCode as string) }),
    links: blobLinks(parsed.sessionId, parsed.blobId),
  };
}

function validateUploadResource(value: unknown, limits: BlobTransferLimits): SessionUploadResource {
  if (!isRecord(value) || !isRecord(value.metadata) || !isRecord(value.links)) {
    throw new BlobStoreError("corrupt_blob_state", "session upload resource is invalid");
  }
  const fileId = fileIdentifier(value.fileId as string);
  const sessionId = boundedIdentifier(value.sessionId as string, "session ID", 256);
  const generation = nonNegativeInteger(value.generation as number, "generation");
  const blobId = blobIdentifier(value.blobId as string);
  const name = metadataName(value.metadata.name as string, limits.maxNameBytes);
  const mediaType = metadataMediaType(value.metadata.mediaType as string, limits.maxMediaTypeBytes);
  const sizeBytes = nonNegativeInteger(value.sizeBytes as number, "sizeBytes");
  if (
    value.contractVersion !== BLOB_TRANSFER_CONTRACT_VERSION ||
    value.relativeRef !== `uploads/${fileId}` ||
    value.metadata.trust !== "untrusted" ||
    sizeBytes > limits.maxBlobBytes ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.expiresAt) ||
    JSON.stringify(value.links) !== JSON.stringify(uploadLinks(sessionId, fileId))
  ) {
    throw new BlobStoreError("corrupt_blob_state", "session upload resource is invalid");
  }
  return {
    contractVersion: BLOB_TRANSFER_CONTRACT_VERSION,
    fileId,
    sessionId,
    generation,
    blobId,
    relativeRef: `uploads/${fileId}`,
    metadata: { name, mediaType, trust: "untrusted" },
    sizeBytes,
    sha256: sha256Digest(value.sha256 as string),
    createdAt: value.createdAt as string,
    expiresAt: value.expiresAt as string,
    links: uploadLinks(sessionId, fileId),
  };
}

function omitReferenceCount(
  resource: BlobTransferResource,
): Omit<BlobTransferResource, "referenceCount"> {
  const { referenceCount: ignored, ...persisted } = resource;
  void ignored;
  return persisted;
}

async function validateContentObject(
  path: string,
  expectedSha256: string,
  expectedBytes: number,
): Promise<void> {
  await validatePrivateFileIfExists(path, "blob content file");
  const info = await lstat(path).catch((error: unknown) => {
    throw nodeStoreError(error, "corrupt_blob_state", "blob content file is missing");
  });
  if (info.isSymbolicLink() || !info.isFile() || info.size !== expectedBytes) {
    throw new BlobStoreError("corrupt_blob_state", "blob content file is invalid");
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  if (digest.digest("hex") !== expectedSha256) {
    throw new BlobStoreError(
      "corrupt_blob_state",
      "blob content does not match its SHA-256 address",
    );
  }
}

async function writeAll(handle: FileHandle, value: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < value.length) {
    const { bytesWritten } = await handle.write(value, offset, value.length - offset);
    if (bytesWritten <= 0) throw new Error("blob content write made no progress");
    offset += bytesWritten;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function validatePolicyResult(value: BlobContentPolicyResult): void {
  if (value.disposition === "allow") return;
  if (value.disposition === "quarantine") {
    policyCode(value.code);
    return;
  }
  throw new Error("content policy returned an invalid disposition");
}

function metadataName(value: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new BlobStoreError("invalid_blob_metadata", "blob display name is invalid");
  }
  const normalized = value.normalize("NFC");
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) {
    throw new BlobStoreError("invalid_blob_metadata", "blob display name is invalid");
  }
  return normalized;
}

function metadataMediaType(value: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(value)
  ) {
    throw new BlobStoreError("invalid_blob_metadata", "blob media type is invalid");
  }
  return value.toLowerCase();
}

function blobIdentifier(value: string): string {
  if (typeof value !== "string" || !/^blob-[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new BlobStoreError("invalid_blob_id", "blob identifier is invalid");
  }
  return value;
}

function fileIdentifier(value: string): string {
  if (typeof value !== "string" || !/^file-[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new BlobStoreError("invalid_file_id", "session upload identifier is invalid");
  }
  return value;
}

function sha256Digest(value: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new BlobStoreError("invalid_blob_hash", "blob SHA-256 is invalid");
  }
  return value;
}

function policyCode(value: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(value)) {
    throw new BlobStoreError("invalid_content_policy", "content policy code is invalid");
  }
  return value;
}

function boundedIdentifier(value: string, field: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000\r\n]/u.test(value)
  ) {
    throw new BlobStoreError("invalid_blob_request", `${field} is invalid`);
  }
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be positive`);
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be non-negative`);
  return value;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeStoreError(error: unknown, code: string, message: string): BlobStoreError {
  if (error instanceof BlobStoreError) return error;
  return new BlobStoreError(code, message);
}
