---
layout: default
title: Dashboard identity and authorization
---

# Dashboard identity and authorization

Dash v1 deliberately has one operator trust domain. Its generated web token is
exchanged for an ephemeral HttpOnly browser session, but every authenticated
browser has the same authority. Multi-user mode is therefore not an ACL field
added to inventory or workspace JSON. It is a separate authentication and
central policy system whose enforcement must cover every HTTP, WebSocket,
embedded, and dedicated boundary before the mode can be enabled.

This document is the threat model and architecture for `bd-b31a5d`. The first
foundation slice exports the identity/provider and policy-ledger contracts but
does **not** expose multi-user configuration. The existing single-owner runtime
continues unchanged until the enforcement slice is complete.

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
login UI, cookies, and restart behavior remain valid.

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
window; resource administrators may read only the matching resource window. A
monotonic next sequence and dropped-event count make truncation explicit instead
of pretending the retained window is complete.

## Migration and enablement

Migration has two explicit modes:

- `single-owner` (default): an absent policy grants implicit resource admin only
  to `local-owner`. This exactly preserves the current installation without a
  bulk state rewrite.
- `multi-user`: absent policy grants no member authority. Global administrators
  may see/adopt unowned legacy inventory; all other resources require an
  explicit policy.

The service must refuse multi-user configuration until route/stream enforcement,
filtered paging, revocation, administration, and migration acceptance are all
available. There is no intermediate mode where several identities authenticate
but share v1's all-powerful browser backend.

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
  foundation. No multi-user runtime switch.
- `bd-fce8f4` — policy enforcement across HTTP/stream and embedded/dedicated
  backends with bounded no-existence-leak inventory paging and compatibility
  migration (implemented).
- `bd-284b03` — grant/workspace administration, revocation, ownership and
  controller transfer with revisions, idempotency, audit and accessible UI.
- `bd-9d9899` — credential-path configuration, migration/operations, full UI,
  restart/revocation/no-leak/security parity and release gates.
