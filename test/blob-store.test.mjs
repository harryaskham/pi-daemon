import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  BlobStoreError,
  FileBlobStore,
  blobIdForScope,
  fileIdForScope,
} from "../dist/blob-store.js";

const roots = [];
const temporaryState = async () => {
  const path = await mkdtemp(join(tmpdir(), "pi-daemon-blobs-"));
  roots.push(path);
  return path;
};

test.after(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const digest = (value) => createHash("sha256").update(value).digest("hex");
const chunks = async function* (...values) {
  for (const value of values) yield value;
};

const reservation = (blobId, value, overrides = {}) => ({
  blobId,
  sessionId: "session-a",
  generation: 3,
  metadata: { name: "shared document.txt", mediaType: "text/plain" },
  sizeBytes: value.length,
  sha256: digest(value),
  ...overrides,
});

test("opaque uploads verify streamed bytes and materialize only daemon-owned session references", async () => {
  const stateDir = await temporaryState();
  const store = new FileBlobStore({ stateDir });
  const value = Buffer.from("bounded shared content", "utf8");
  const blobId = blobIdForScope("reserve\nsession-a\n3\nonce");
  const fileId = fileIdForScope("materialize\nsession-a\n3\nonce");

  const reserved = await store.reserve(reservation(blobId, value));
  assert.equal(reserved.state, "reserved");
  assert.equal(reserved.metadata.trust, "untrusted");
  assert.equal(reserved.referenceCount, 0);

  const uploaded = await store.uploadContent(
    blobId,
    "session-a",
    3,
    "upload-once",
    chunks(value.subarray(0, 7), value.subarray(7)),
  );
  assert.equal(uploaded.state, "available");
  assert.equal(uploaded.sha256, digest(value));

  const materialized = await store.materialize({
    fileId,
    sessionId: "session-a",
    generation: 3,
    blobId,
    // Deliberately ignored: the v1 store exposes no caller-selected destination.
    path: "../../outside",
  });
  assert.equal(materialized.relativeRef, `uploads/${fileId}`);
  assert.equal(materialized.relativeRef.includes(".."), false);
  assert.equal(materialized.metadata.trust, "untrusted");
  assert.equal((await store.getBlob(blobId, "session-a", 3)).referenceCount, 1);

  const opened = await store.referenceContent(fileId, "session-a", 3);
  assert.deepEqual(await readFile(opened.path), value);
  assert.equal((await stat(opened.path)).mode & 0o077, 0);
  await assert.rejects(
    store.deleteBlob(blobId, "session-a", 3),
    (error) => error instanceof BlobStoreError && error.code === "blob_in_use",
  );
  assert.equal(await store.deleteReference(fileId, "session-a", 3), true);
  assert.equal(await store.deleteBlob(blobId, "session-a", 3), true);
  assert.equal(await store.getBlob(blobId, "session-a", 3), undefined);
});

test("verified backing objects are SHA-256 addressed and shared across opaque aliases", async () => {
  const stateDir = await temporaryState();
  const store = new FileBlobStore({ stateDir });
  const value = Buffer.from("one immutable backing object", "utf8");
  const sha256 = digest(value);
  const firstBlobId = blobIdForScope("content-alias-first");
  const secondBlobId = blobIdForScope("content-alias-second");
  await store.reserve(reservation(firstBlobId, value));
  await store.reserve(
    reservation(secondBlobId, value, {
      sessionId: "session-b",
      generation: 9,
      metadata: { name: "same bytes.bin", mediaType: "application/octet-stream" },
    }),
  );
  await store.uploadContent(firstBlobId, "session-a", 3, "first-upload", chunks(value));
  await store.uploadContent(secondBlobId, "session-b", 9, "second-upload", chunks(value));

  assert.equal(store.capabilities.contentAddressedSha256, true);
  assert.deepEqual(await readdir(store.objectsDir), [`${sha256}.bin`]);
  const firstContent = await store.blobContent(firstBlobId, "session-a", 3);
  const secondContent = await store.blobContent(secondBlobId, "session-b", 9);
  assert.equal(firstContent.path, join(store.objectsDir, `${sha256}.bin`));
  assert.equal(secondContent.path, firstContent.path);

  const firstFileId = fileIdForScope("content-alias-first");
  const secondFileId = fileIdForScope("content-alias-second");
  await store.materialize({
    fileId: firstFileId,
    sessionId: "session-a",
    generation: 3,
    blobId: firstBlobId,
  });
  await store.materialize({
    fileId: secondFileId,
    sessionId: "session-b",
    generation: 9,
    blobId: secondBlobId,
  });
  assert.equal((await store.getBlob(firstBlobId, "session-a", 3)).referenceCount, 1);
  assert.equal((await store.getBlob(secondBlobId, "session-b", 9)).referenceCount, 1);

  await store.deleteReference(firstFileId, "session-a", 3);
  await store.deleteBlob(firstBlobId, "session-a", 3);
  assert.deepEqual(await readdir(store.objectsDir), [`${sha256}.bin`]);
  assert.deepEqual(await readFile((await store.blobContent(secondBlobId, "session-b", 9)).path), value);

  await store.deleteReference(secondFileId, "session-b", 9);
  await store.deleteBlob(secondBlobId, "session-b", 9);
  assert.deepEqual(await readdir(store.objectsDir), []);
});

test("content quota counts one declared SHA-256 object across aliases", async () => {
  const stateDir = await temporaryState();
  const value = Buffer.from("deduplicated quota", "utf8");
  const store = new FileBlobStore({
    stateDir,
    limits: {
      maxBlobs: 3,
      maxBlobsPerSession: 3,
      maxBlobBytes: value.length + 1,
      maxTotalBytes: value.length + 1,
    },
  });
  await store.reserve(reservation(blobIdForScope("quota-first"), value));
  await store.reserve(reservation(blobIdForScope("quota-alias"), value));
  await assert.rejects(
    store.reserve(reservation(blobIdForScope("quota-distinct"), Buffer.from("xx"))),
    (error) => error instanceof BlobStoreError && error.code === "blob_capacity",
  );
  await assert.rejects(
    store.reserve(
      reservation(blobIdForScope("quota-invalid-size-alias"), Buffer.concat([value, Buffer.from("x")]), {
        sha256: digest(value),
      }),
    ),
    (error) => error instanceof BlobStoreError && error.code === "blob_reservation_conflict",
  );
});

test("content-addressed aliases and references recover without duplicate backing bytes", async () => {
  const stateDir = await temporaryState();
  const value = Buffer.from("restart-safe content address", "utf8");
  const sha256 = digest(value);
  const firstBlobId = blobIdForScope("recovery-alias-first");
  const secondBlobId = blobIdForScope("recovery-alias-second");
  const first = new FileBlobStore({ stateDir });
  await first.reserve(reservation(firstBlobId, value));
  await first.reserve(
    reservation(secondBlobId, value, { sessionId: "session-b", generation: 9 }),
  );
  await first.uploadContent(firstBlobId, "session-a", 3, "first-upload", chunks(value));
  await first.uploadContent(secondBlobId, "session-b", 9, "second-upload", chunks(value));
  await first.materialize({
    fileId: fileIdForScope("recovery-reference"),
    sessionId: "session-a",
    generation: 3,
    blobId: firstBlobId,
  });

  const restarted = new FileBlobStore({ stateDir });
  const recovery = await restarted.recover();
  assert.equal(recovery.blobs.length, 2);
  assert.equal(recovery.references.length, 1);
  assert.deepEqual(await readdir(restarted.objectsDir), [`${sha256}.bin`]);
  assert.equal((await restarted.getBlob(firstBlobId, "session-a", 3)).referenceCount, 1);
  assert.equal((await restarted.getBlob(secondBlobId, "session-b", 9)).referenceCount, 0);
  assert.deepEqual(
    await readFile((await restarted.blobContent(secondBlobId, "session-b", 9)).path),
    value,
  );
});

test("default content policy quarantines archives and active content without parsing it", async () => {
  const stateDir = await temporaryState();
  const store = new FileBlobStore({ stateDir });
  for (const [scope, mediaType, quarantineCode] of [
    ["archive-default", "application/zip", "archive_requires_policy"],
    ["active-default", "text/html", "active_content_denied"],
  ]) {
    const value = Buffer.from(scope, "utf8");
    const blobId = blobIdForScope(scope);
    await store.reserve(
      reservation(blobId, value, {
        metadata: { name: `${scope}.bin`, mediaType },
      }),
    );
    const result = await store.uploadContent(
      blobId,
      "session-a",
      3,
      `${scope}-upload`,
      chunks(value),
    );
    assert.equal(result.state, "quarantined");
    assert.equal(result.quarantineCode, quarantineCode);
    await assert.rejects(
      store.blobContent(blobId, "session-a", 3),
      (error) => error instanceof BlobStoreError && error.code === "blob_quarantined",
    );
  }

  const safeValue = Buffer.from("safe text", "utf8");
  const safeBlobId = blobIdForScope("safe-default");
  await store.reserve(reservation(safeBlobId, safeValue));
  assert.equal(
    (await store.uploadContent(safeBlobId, "session-a", 3, "safe-upload", chunks(safeValue))).state,
    "available",
  );
});

test("hash, size, generation, and upload idempotency fail closed without executing content", async () => {
  const stateDir = await temporaryState();
  let policyCalls = 0;
  const store = new FileBlobStore({
    stateDir,
    contentPolicy: ({ metadata }) => {
      policyCalls += 1;
      assert.equal(metadata.trust, "untrusted");
      return { disposition: "allow" };
    },
  });
  const value = Buffer.from("verify me", "utf8");
  const blobId = blobIdForScope("verification");
  await store.reserve(reservation(blobId, value));

  await assert.rejects(
    store.uploadContent(blobId, "session-a", 4, "upload", chunks(value)),
    (error) =>
      error instanceof BlobStoreError && error.code === "blob_session_precondition_failed",
  );
  await assert.rejects(
    store.uploadContent(blobId, "session-a", 3, "upload", chunks(value.subarray(1))),
    (error) => error instanceof BlobStoreError && error.code === "blob_size_mismatch",
  );
  assert.equal((await store.getBlob(blobId, "session-a", 3)).state, "reserved");
  assert.equal(policyCalls, 0);

  const settled = await store.uploadContent(blobId, "session-a", 3, "upload", chunks(value));
  assert.equal(settled.state, "available");
  assert.equal(policyCalls, 1);
  const replay = await store.uploadContent(blobId, "session-a", 3, "upload", chunks(Buffer.alloc(0)));
  assert.equal(replay.state, "available");
  assert.equal(policyCalls, 1);
  await assert.rejects(
    store.uploadContent(blobId, "session-a", 3, "different-key", chunks(value)),
    (error) => error instanceof BlobStoreError && error.code === "idempotency_conflict",
  );
});

test("content policy quarantine retains metadata but denies content and references", async () => {
  const stateDir = await temporaryState();
  const store = new FileBlobStore({
    stateDir,
    contentPolicy: () => ({ disposition: "quarantine", code: "scanner_rejected" }),
  });
  const value = Buffer.from("opaque", "utf8");
  const blobId = blobIdForScope("quarantine");
  await store.reserve(reservation(blobId, value));
  const quarantined = await store.uploadContent(
    blobId,
    "session-a",
    3,
    "upload",
    chunks(value),
  );
  assert.equal(quarantined.state, "quarantined");
  assert.equal(quarantined.quarantineCode, "scanner_rejected");
  assert.equal((await store.getBlob(blobId, "session-a", 3)).metadata.name, "shared document.txt");
  await assert.rejects(
    store.blobContent(blobId, "session-a", 3),
    (error) => error instanceof BlobStoreError && error.code === "blob_quarantined",
  );
  await assert.rejects(
    store.materialize({
      fileId: fileIdForScope("quarantined-reference"),
      sessionId: "session-a",
      generation: 3,
      blobId,
    }),
    (error) => error instanceof BlobStoreError && error.code === "blob_quarantined",
  );
});

test("TTL, quotas, recovery, and refcounts bound retained owner-private content", async () => {
  const stateDir = await temporaryState();
  let now = new Date("2026-08-03T10:00:00.000Z");
  const options = {
    stateDir,
    now: () => now,
    limits: {
      maxBlobs: 2,
      maxBlobsPerSession: 1,
      maxBlobBytes: 32,
      maxTotalBytes: 32,
      maxReferences: 2,
      maxReferencesPerBlob: 1,
      reservationTtlMs: 100,
      blobTtlMs: 1_000,
      referenceTtlMs: 2_000,
    },
  };
  const value = Buffer.from("retained", "utf8");
  const blobId = blobIdForScope("retained");
  const fileId = fileIdForScope("retained");
  const first = new FileBlobStore(options);
  await first.reserve(reservation(blobId, value));
  await assert.rejects(
    first.reserve(reservation(blobIdForScope("second"), value)),
    (error) => error instanceof BlobStoreError && error.code === "blob_capacity",
  );
  await first.uploadContent(blobId, "session-a", 3, "upload", chunks(value));
  await first.materialize({ fileId, sessionId: "session-a", generation: 3, blobId });
  const referencePath = (await first.referenceContent(fileId, "session-a", 3)).path;
  const orphanReference = join(dirname(referencePath), `file-${"d".repeat(43)}.bin`);
  const orphanBlob = join(first.objectsDir, `${"e".repeat(64)}.bin`);
  await writeFile(orphanReference, value, { mode: 0o600 });
  await writeFile(orphanBlob, value, { mode: 0o600 });

  const restarted = new FileBlobStore(options);
  const recovery = await restarted.recover();
  assert.equal(recovery.blobs.length, 1);
  assert.equal(recovery.blobs[0].referenceCount, 1);
  assert.equal(recovery.references.length, 1);
  assert.deepEqual(await readFile((await restarted.referenceContent(fileId, "session-a", 3)).path), value);
  await assert.rejects(readFile(orphanReference), (error) => error?.code === "ENOENT");
  await assert.rejects(readFile(orphanBlob), (error) => error?.code === "ENOENT");

  now = new Date("2026-08-03T10:00:01.500Z");
  await restarted.prune();
  assert.equal((await restarted.getBlob(blobId, "session-a", 3)).referenceCount, 1);
  now = new Date("2026-08-03T10:00:02.500Z");
  assert.equal(await restarted.prune(), 2);
  assert.equal(await restarted.getBlob(blobId, "session-a", 3), undefined);
  assert.equal(await restarted.getReference(fileId, "session-a", 3), undefined);
});

test("session generation teardown removes inbox references before their backing blobs", async () => {
  const stateDir = await temporaryState();
  const store = new FileBlobStore({ stateDir });
  const value = Buffer.from("old generation", "utf8");
  const blobId = blobIdForScope("old-generation");
  const fileId = fileIdForScope("old-generation");
  await store.reserve(reservation(blobId, value));
  await store.uploadContent(blobId, "session-a", 3, "upload", chunks(value));
  await store.materialize({ fileId, sessionId: "session-a", generation: 3, blobId });
  assert.equal(await store.deleteGeneration("session-a", 3), 2);
  assert.equal(await store.getReference(fileId, "session-a", 3), undefined);
  assert.equal(await store.getBlob(blobId, "session-a", 3), undefined);
});

test("aborted staging and malformed metadata leave no available content", async () => {
  const stateDir = await temporaryState();
  const store = new FileBlobStore({ stateDir });
  const value = Buffer.from("content", "utf8");
  const blobId = blobIdForScope("aborted");
  await assert.rejects(
    store.reserve(reservation(blobId, value, { metadata: { name: "bad\nname", mediaType: "text/plain" } })),
    (error) => error instanceof BlobStoreError && error.code === "invalid_blob_metadata",
  );
  await store.reserve(reservation(blobId, value));
  const failure = new Error("client disconnected");
  const aborted = async function* () {
    yield value.subarray(0, 2);
    throw failure;
  };
  await assert.rejects(store.uploadContent(blobId, "session-a", 3, "upload", aborted()), failure);
  assert.equal((await store.getBlob(blobId, "session-a", 3)).state, "reserved");

  // Recovery removes an owner-private orphan upload temporary without treating
  // it as content or widening the public resource.
  await writeFile(join(store.objectsDir, `.orphan.upload-${process.pid}-fixture`), "partial", { mode: 0o600 });
  const restarted = new FileBlobStore({ stateDir });
  const recovery = await restarted.recover();
  assert.equal(recovery.blobs.length, 1);
  assert.equal(recovery.blobs[0].state, "reserved");
});
