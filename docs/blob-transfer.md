---
layout: default
title: Neutral blob and session file transfer
---

# Neutral blob and session file transfer

Status: **versioned implementation contract for API 1.x**.

Pi Daemon exposes a client-neutral way to stage opaque bytes for one exact
logical-session generation. It is intended for Pi Droid, Dash, CLI clients, and
other trusted service-bearer consumers; it contains no Android or Cacophony
concepts.

This API is not ambient filesystem authority. A client can never submit an
absolute path, cwd-relative destination, shell command, extension, or tool
capability. Materialization produces only a daemon-chosen `uploads/<fileId>`
reference inside an owner-private session inbox. No route writes into the
session cwd.

## Contract and routes

Every route authenticates the service bearer before reading a body or revealing
session/blob existence.

| Method and path | Meaning | Result |
| --- | --- | --- |
| `POST /v1/session/{sessionRef}/blob` | reserve declared size, SHA-256, and untrusted metadata | durable `reserve_blob` ticket |
| `GET /v1/session/{sessionRef}/blob/{blobId}?generation=N` | metadata/status only | blob resource |
| `PUT /v1/session/{sessionRef}/blob/{blobId}/content?generation=N` | bounded opaque upload | verified blob resource |
| `GET /v1/session/{sessionRef}/blob/{blobId}/content?generation=N` | available, non-quarantined bytes | `application/octet-stream` |
| `DELETE /v1/session/{sessionRef}/blob/{blobId}?generation=N` | delete an unreferenced alias | durable `delete_blob` ticket |
| `POST /v1/session/{sessionRef}/file` | create a daemon-owned session reference | durable `materialize_blob` ticket |
| `GET /v1/session/{sessionRef}/file/{fileId}?generation=N` | inspect reference metadata | upload-reference resource |
| `GET /v1/session/{sessionRef}/file/{fileId}/content?generation=N` | download through the reference | `application/octet-stream` |
| `DELETE /v1/session/{sessionRef}/file/{fileId}?generation=N` | remove the reference | durable `delete_file` ticket |

`POST` and `DELETE` require `Idempotency-Key`; ticketed calls optionally accept
`waitForTerminal=true`. Content `PUT` also requires `Idempotency-Key`. A failed or
interrupted reserved upload may retry the whole bounded stream with the same key.
Once content settles as available or quarantined, a different key cannot replace
it.

Reservation body:

```json
{
  "requestId": "share-01",
  "expectedGeneration": 3,
  "metadata": {
    "name": "report.pdf",
    "mediaType": "application/pdf"
  },
  "sizeBytes": 12345,
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

Materialization body deliberately has no path:

```json
{
  "requestId": "materialize-01",
  "expectedGeneration": 3,
  "blobId": "blob-opaque-id"
}
```

## Streaming, verification, and content addressing

The server checks a declared `Content-Length` before reading when present, then
counts actual bytes while streaming to an owner-private temporary file. It
computes SHA-256 incrementally and publishes nothing unless both byte count and
digest match the reservation.

Verified backing bytes are immutable objects named `objects/<sha256>.bin`.
Multiple opaque blob IDs with identical bytes share that one object, including
across sessions, but this does not grant cross-session access: every API lookup,
upload, download, materialization, and cleanup remains bound to the exact
canonical `sessionId` and generation. Cross-session reuse is therefore storage
deduplication only, never authorization reuse.

Session upload references and blob aliases have independent bounded refcounts
and TTLs. Deleting one alias retains a shared object while another settled alias
exists. Deleting the last unreferenced alias removes the object. Recovery rehashes
and size-checks every settled object, rejects missing or mismatched state, removes
orphan temporary/object files, and restores alias/reference counts before
admission.

## Content policy and quarantine

Name and MIME are always labelled `trust: "untrusted"`. Downloads use
`application/octet-stream`, `Content-Disposition: attachment`, `nosniff`, and a
verified `Digest`; the declared media type is returned only in an explicitly
untrusted header/metadata field.

The default metadata-only policy never parses or executes content. It allows
ordinary inert data, but quarantines declared archive/container types with
`archive_requires_policy` and active/executable types with
`active_content_denied`. Quarantined metadata remains inspectable; content
cannot be downloaded or materialized. Operators may inject a stronger bounded
scanner policy. A scanner failure becomes `content_policy_error` quarantine,
not implicit acceptance.

The default is deliberately not malware detection: declared MIME can lie. The
security guarantee is that Pi Daemon does not interpret or execute staged
content and does not release policy-denied bytes through transfer routes.

## Bounds and cleanup

Capabilities advertise exact count, byte, record, recovery, per-session,
per-blob-reference, and TTL limits. Defaults are 256 blob aliases, 32 aliases per
session, 64 MiB per blob, a 512 MiB unique declared-object aggregate, 512 session
references, and 24-hour settled/reference TTLs. Aliases declaring the same
SHA-256 count that object's size once and must agree on size. Reservations expire
after one hour.

Disconnect/cancellation removes the current temporary stream and leaves the
reservation retryable under its original key. Startup removes abandoned stream
and atomic-write temporaries. Session-generation replacement or destructive
session deletion removes its inbox references before deleting now-unreferenced
aliases/objects. Accepted ticket work is never blindly replayed after an
indeterminate crash; normal ticket reconciliation rules apply.

## Client rules

- Compute the exact SHA-256 and actual byte count before reservation. Providers
  with unknown size must stage/count locally first.
- Treat metadata as display hints only.
- Never synthesize or persist server filesystem paths; retain opaque blob/file
  IDs and the bounded relative reference only.
- Reconcile tickets and same-key retries before choosing a fresh key.
- Disable generic file sharing honestly when `blobTransfers.available` is false.
- Do not embed bytes as oversized base64 Pi RPC frames as a fallback.

The normative machine-readable definitions are in
[`session-api.schema.json`](session-api.schema.json), the HTTP contract is in
[`session-api.openapi.json`](session-api.openapi.json), and valid/invalid
compatibility fixtures live under `fixtures/session-api/`.
