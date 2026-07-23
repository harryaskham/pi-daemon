---
layout: default
title: Dashboard identity and authorization
---

# Dashboard identity and authorization

Dash v1 started with one operator trust domain: its generated web token was
exchanged for an ephemeral HttpOnly browser session and every authenticated
browser had the same authority. Multi-user mode is therefore not an ACL field
added to inventory or workspace JSON. It is a separate authentication and
central policy system enforced at every HTTP, WebSocket, embedded, and dedicated
boundary.

This document is the threat model and completed architecture for `bd-b31a5d`.
Single-owner remains the exact default. Multi-user activation is explicit and
requires a strict startup-loaded identity provider whose secret material comes
only from bounded owner-only files or inherited descriptors.

## Trust boundaries

There are four distinct actors:

1. **Daemon service client.** It presents the owner-private service bearer to
   the neutral session/Dash API. This remains a machine trust domain and never
   becomes a browser identity.
2. **Dedicated or embedded BFF.** It may hold the service bearer in the dedicated
   process, authenticates browser credentials, applies all browser policy, and
   never forwards browser cookies/CSRF values as daemon credentials.
3. **Browser principal.** A credential provider resolves an input-only proof to
   a stable identity and global role. The resulting principal exists only in
   server-side browser-session state.
4. **Resource policy ledger.** One owner-private, revisioned store is the sole
   source for session/workspace/draft/ticket/schedule ownership and grants.
   Existing v1 resources carry no ACL properties.

A shared Node process remains one operating-system trust domain. Multi-user Dash
prevents one authenticated browser principal from exercising another
principal's application authority; it does not sandbox malicious extensions,
provider code, or a compromised daemon process.

## Threats and required responses

| Threat | Required response |
|---|---|
| credential guessing or identity enumeration | high-entropy tokens, bounded input, compare every configured digest, one generic login failure |
| cookie theft/replay | random HMAC-signed HttpOnly SameSite=Strict cookie, Secure `__Host-` form under HTTPS, bounded TTL and explicit revocation |
| browser identity spoofing | principal is server-side and never accepted from a frame, query, forwarded header, workspace ID, or client ID |
| guessed resource IDs | absent and unauthorized resources produce the same 404 code/message/body shape |
| inventory side channels | filter before browser serialization and use bounded per-principal opaque paging; never return inaccessible counts, titles, paths, cursors, or timing-specific errors |
| confused deputy in dedicated mode | the BFF enforces browser policy before using its server-only service bearer; browser identity is not delegated as bearer authority |
| stale grant mutation | strong policy revision/ETag plus idempotency at the administration route |
| grant/ownership race | serialize mutation, validate expected revision, atomically publish the complete ledger |
| persistence failure | pre-publication failure rolls memory back; post-rename durability ambiguity poisons authorization until restart/revalidation; corrupt/insecure state never resets allow-all |
| controller stealing | `control` grant is necessary but not sufficient; the existing single-controller lease still applies and transfer revokes/acknowledges the old holder before granting the new one |
| revocation with live channels | close affected browser sessions/subscriptions, release controller state, and reject subsequent HTTP/stream operations immediately |
| audit secret leakage | retain only actor/subject IDs, resource opaque ID, role, action, sequence, and timestamp—never credentials, prompts, canonical paths, model output, or bearer values |
| unbounded tenants/policies | fixed identity, policy, grants-per-policy, audit, browser-session, paging, connection, queue, and byte limits |

## Identity-provider contract

A startup-loaded `DashboardIdentityProvider` receives one input-only credential
and returns either a validated `DashboardPrincipal` or no result. It provides no
failure reason. A principal contains:

- stable opaque `identityId`;
- global role `administrator` or `member`; and
- an optional bounded display name.

The built-in static provider is for independently generated high-entropy tokens,
not human passwords. It retains SHA-256 token digests only, rejects duplicate
identity IDs/tokens, requires at least one administrator, and compares every
digest on every attempt. The provider also revalidates server-side identity by
ID; removal or any role/display identity change invalidates subsequent cookie
authentication rather than silently changing authority. The enforcement slice
also closes already-open channels on that revision. Later fixed providers
may implement an audited OIDC or mTLS proof contract, but browser/proxy headers
are never an identity provider. Arbitrary project extensions cannot provide
authentication code in the shared process.

The existing `web.auth.tokenFile` is the compatibility provider. It resolves to
the deterministic `local-owner` administrator, so old YAML, CLI, Home Manager,
login UI, cookies, and restart behavior remain valid. A static provider may be
configured inline at `web.auth.identityProvider`, selected from a strict
non-secret document at `web.auth.identityProviderFile`, or selected by
`--web-identity-provider-file`. Metadata is bounded to 128 identities and exactly
one credential file/descriptor source per identity. Literal secrets are rejected.
Home Manager's `dashboardAuth.identities` writes metadata and runtime secret paths,
never bytes, to the Nix store.

## Browser sessions

`DashboardBrowserAuth` stores the resolved principal with the random session
lookup key, client ID, workspace ID, CSRF digest, and expiry. The cookie contains
only the random key and HMAC. The login response remains credential-free; the
principal is exposed later only through a bounded bootstrap identity summary.
Client-supplied `clientId` and `workspaceId` are correlation values, not
security principals.

Logout, expiry, provider revocation, administrator revocation, and shutdown
close all associated WebSockets. A browser session never contains or receives
the daemon service bearer.

## Central resource policy

A policy is keyed by `{kind, opaque id}` and contains exactly:

- one owner identity;
- zero or more identity grants;
- policy revision and timestamps.

Resource kinds are session, workspace, draft, draft-send ticket, activation
ticket, export ticket, and schedule. Grant roles are ordered:

| Role | Authority |
|---|---|
| `read` | discover the authorized resource, read safe metadata/transcript, observe a Rich/TUI channel |
| `control` | all read authority plus request controller role and mutate the session through allowed commands |
| `admin` | all control authority plus grants, revocation, ownership/controller transfer, export/release and persistent autonomous schedule policy |

The owner has implicit `admin`. A global administrator can inspect/adopt
unowned legacy inventory and recover policy, but ordinary members default deny.
Creating a draft/workspace/session through a trusted BFF call registers the new
resource to that principal. Existing resources are adopted explicitly; a
browser cannot claim a guessed ID merely by sending it.

`STATE_DIR/web/authorization-v1.json` is owner-only and atomically published.
It has fixed policy, grants, audit, and total-byte bounds. Each mutation is
serialized, validates an expected policy revision, appends a content-free audit
event, and fsyncs the file and directory. A failure before rename rolls the
in-memory draft back. A failure after rename is explicitly indeterminate and
poisons the in-process authorizer until restart revalidates the owner-only file;
it never serves authority from a state that might disagree with disk. Invalid
UTF-8/JSON/schema, symlinks, wrong owner/mode, and oversize state fail closed
without quarantine/reset.

Audit retention is bounded. Global administrators may read the retained global
window with its monotonic sequence and dropped-event count. Resource
administrators receive only the matching retained window with window-relative
sequences; global gaps and truncation counts are deliberately withheld so they
cannot become an inaccessible-resource activity oracle.

## Administration and live controller handoff

The same-origin BFF exposes bounded administrator-only resources under
`/dash/v1/authorization/{session|workspace}/{opaqueId}`. Policy GET returns an
exact ETag. Grant PUT/revoke DELETE and ownership-transfer POST require CSRF,
matching `If-Match`, matching request/header IDs, an expected revision, and a
retained durable idempotency key. A retry returns the retained policy snapshot;
reusing the key with different content fails. Targets must be present in the
configured identity provider, but unsuccessful lookups never disclose another
resource.

`GET /dash/v1/workspaces` lists at most 100 authorized workspaces, and
`POST /dash/v1/workspaces/select` rebinds only the current server-side browser
session after workspace-read authorization. Revoking the selected workspace
immediately revokes matching browser sessions and their streams. The SPA's
accessible **Access & controller** dialog supports workspace switching,
session/workspace grants, revocation, ownership transfer, audit inspection, and
controller handoff without storing identity authority in browser state.

Every Rich/TUI subscription registers one bounded live controller participant
against its canonical central resource. The handoff endpoint requires both the
policy ETag and a separate controller revision ETag. It validates that the target
has at least `control`, releases the old backend controller and waits for that
result, then requests target control. It never restores the old controller
implicitly after a failed target grant. A successful handoff appends exactly one
durable, content-free `controller-transferred` audit event; same-process retries
reuse a bounded idempotency result. Policy revocation closes readers or releases
downgraded controllers immediately.

## Migration and enablement

Migration has two explicit modes:

- `single-owner` (default): an absent policy grants implicit resource admin only
  to `local-owner`. This exactly preserves the current installation without a
  bulk state rewrite.
- `multi-user`: absent policy grants no member authority. Global administrators
  may see/adopt unowned legacy inventory; all other resources require an
  explicit policy.

A configured provider activates `multi-user` atomically at startup.
There is no intermediate mode where several identities authenticate but share v1's
all-powerful browser backend. With no provider, `single-owner` remains exact.
Provider activation does not rewrite existing policy. Old `local-owner` resources
remain durable and recoverable by a configured global administrator, who can
transfer them through the normal revisioned administration API. Restart revokes
all old browser cookies, and the legacy web token is not accepted while the
provider is active. Removing the provider is an explicit rollback to exact
single-owner semantics.

## Enforcement map

- inventory/list/info/transcript and observer subscriptions require `read`;
- prompt/model/tree mutation, TUI input, activation reuse, and ordinary schedule
  inspection require `control` as specified by route policy;
- direct/fork activation of unowned inventory, export/release, persistent
  schedules, sharing, revocation, ownership transfer, and forced controller
  transfer require `admin`;
- workspace GET requires workspace `read`; layout/seen mutation requires
  workspace `control`; sharing/transfer requires workspace `admin`;
- ticket and draft access follows its registered owner/grants and never trusts a
  target ID supplied after creation;
- a WebSocket authorization snapshot is rechecked on sensitive operations and
  invalidated on policy/provider revision so revocation is not delayed until
  reconnect.

Remote `DashboardBackend` and the neutral service API remain service-bearer
surfaces. The dedicated BFF applies the same browser authorizer as embedded mode
before issuing protected resource operations. A bounded identity-free info read
may resolve an opaque inventory alias before the decision, but its result is
never returned on denial. Browser identity is not inserted into neutral service
payloads, logs, or authorization headers.

### Enforced browser boundary

`DashboardAuthorizationEnforcer` is the browser-facing adapter shared by HTTP
and the Rich/TUI stream router. It resolves inventory aliases, Pi session IDs,
and managed session IDs to central `session` policies; backends never receive a
principal. Direct resource lookups fetch the same bounded metadata before
returning the same content-free `not_found` envelope for an absent or unauthorized
session. Tickets, drafts, workspaces, and schedules consult policy before their
backend lookup, so guessing an ID cannot probe the machine service.

Inventory responses use bounded scan-ahead and random server-side cursors bound
to the principal and query fingerprint. The browser never receives the
underlying all-session cursor, skipped records, or a count of inaccessible
records. A continuation is emitted only after scan-ahead has found at least one
additional authorized record; an unauthorized-only horizon never becomes a
cardinality oracle. Cursor storage, buffered authorized records, lifetime, and
scans per request are hard bounded.
Multi-user login ignores the untrusted requested workspace ID and uses a stable,
opaque identity-derived workspace, preventing a login request from claiming or
probing somebody else's workspace. The compatibility provider preserves its
existing requested workspace exactly.

Observer streams require session `read`; controller opens require `control`.
Every command, control request, extension response, TUI input/resize, and emitted
Rich/TUI event revalidates both the provider-backed browser session and current
policy. Loss of authority closes the subscription and therefore releases its
backend controller/lease instead of allowing revocation to wait for reconnect.
The WebSocket handshake also requires workspace `read`.

Settings reads and capability metadata contain no cross-user resource identity;
settings mutation and aggregate scheduler status are global-administrator only.
Schedule lists are filtered, schedule inspection requires `control`, and
persistent schedule mutation requires resource/session `admin`.

## Delivery slices

- `bd-07a348` — this threat model, principal/provider contract, identity-bound
  server session state, central fail-closed policy ledger, audit and package
  foundation (implemented).
- `bd-fce8f4` — policy enforcement across HTTP/stream and embedded/dedicated
  backends with bounded no-existence-leak inventory paging and compatibility
  migration (implemented).
- `bd-284b03` — grant/workspace administration, revocation, ownership and
  controller transfer with revisions, idempotency, audit and accessible UI
  (implemented).
- `bd-9d9899` — credential-path configuration, migration/operations, full UI,
  restart/revocation/no-leak/security parity and release gates (implemented).
