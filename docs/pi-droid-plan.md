---
layout: default
title: Pi Droid Android client plan
---

# Pi Droid Android client plan

Status: staged implementation active; encrypted release material, JVM SDK/UI
foundations, and Pi Droid preview 6 with screenshot-tested adaptive UX plus all
preview 5 daily-driver multi-host and session lifecycle support are live on Play
internal. External-canary physical proof remains separate work.

Package/application ID: `com.harryaskham.pidroid`  
Product name: **Pi Droid**  
Google Play internal-testing app/track: version 6 completed on `internal`
Pre-registered signing certificate SHA-256:
`FA:58:80:A7:C9:6D:F8:7B:B4:63:7D:18:58:7E:32:F6:CD:F6:95:06:52:34:FE:54:95:E2:4F:ED:12:1E:CE:4C`

## 1. Product statement

Pi Droid is the first-party Android client for Pi Daemon. It is a pure client:
it does not install, supervise, update, or embed Pi Daemon. A daemon may happen
to run on the same Android device, but its lifecycle remains external to the
app and it is registered like any other host.

The app must make a remote resident Pi session feel as immediate and trustworthy
as local Pi. It provides the same logical session semantics as Pi Daemon's web
client and Pi RPC surface, adds Android-native multi-host, notification, share,
widget, and floating-window integration, and never invents Cacophony concepts.

Cacophony is a consumer of the Android SDK, not a dependency. Its Android app may
embed canonical Pi Droid session views and supply endpoints either directly or
through an app-local bridge/proxy, but Pi Droid core never imports Cacophony
agents, beads, messages, profiles, lifecycle, or credentials.

## 2. Goals

1. **Feature parity with Pi and Dash.** Inventory, preview, activation, Rich and
   TUI views, Pi commands, wake/prompt, steer, follow-up, abort, models,
   thinking, compaction/retry, tree navigation, drafts, schedules, diagnostics,
   export, declarative extension views, and safe settings are capability-gated
   rather than approximated.
2. **Composable workspaces.** Recursive split panes and tab stacks can be nested
   arbitrarily, resized/reordered, saved, restored, named, duplicated, and used
   on phone, tablet, foldable, desktop mode, and external displays.
3. **Reusable first-party Android SDK views.** The canonical host/session model,
   transport, transcript, composer, TUI, information, and workspace components
   are independently consumable by the Cacophony Android app.
4. **Multi-host by default.** The user can save multiple Pi Daemon endpoints and
   credentials, browse a combined bounded inventory, filter/jump by host, and
   move between sessions without changing app mode.
5. **Canonical freshness.** Cached content is never silently presented as live.
   Host, session, generation, sequence, cursor, revision, and freshness remain
   explicit. Mutations require current server authority.
6. **Excellent Android quality.** Fast startup, responsive scrolling and input,
   good keyboard/IME behavior, adaptive layouts, accessibility, polished
   Material/Compose design, graceful network behavior, and bounded background
   work are release requirements.
7. **Android integration.** Pairing QR codes, notification channels, foreground
   monitored-session mode, widgets, share targets, deep links, multi-window,
   and android-utils floating overlays behave as native Android features.
8. **Internal distribution first.** Every stable Pi Daemon tag can publish one
   signed AAB to Google Play internal testing without adding heavy Android work
   to normal Pi Daemon PR gates.

## 3. Non-goals for the initial app

- Starting, installing, updating, or repairing a Pi Daemon process.
- Cacophony lifecycle or bead/message UI in Pi Droid.
- Silently exposing a remote plaintext bearer endpoint.
- Treating cached inventory/transcript data as authoritative while disconnected.
- FCM-backed reliable push while Pi Daemon has no neutral push-registration API.
- Arbitrary file transfer disguised as oversized base64 Pi RPC frames.
- Embedding web content in a WebView as the production client.
- Reimplementing Pi protocol semantics independently in the app layer.

## 4. Existing Pi Daemon contracts to reuse

Pi Droid should consume the existing language-neutral contracts rather than a
mobile-only BFF:

- `GET /v1/capabilities` for API/RPC/capability negotiation and limits;
- bounded `GET /v1/session` pages across resident and dormant sessions;
- ETag/revision/generation-checked session resources and mutation tickets;
- `pi-daemon-rpc.v1` WebSocket attach with atomic `attach_ready`, monotonic
  sequence, opaque replay cursors, replay gaps, controller leases, and stock Pi
  commands/events;
- `/v1/dashboard/*` neutral inventory, information, transcript preview,
  activation, draft, schedule, diagnostics, and export services;
- `pi-daemon-tui.v1` when negotiated;
- declarative extension-view v1 documents;
- safe error envelopes, idempotency keys, and indeterminate reconciliation.

The Android implementation must import generated Kotlin models from the
repository's JSON Schema/OpenAPI/fixtures or maintain a tested generator. It
must not hand-maintain a divergent copy of Pi RPC string unions.

### Feature parity inventory

The plan treats these as tracked parity groups:

| Area | Pi Droid contract |
| --- | --- |
| Host | capabilities, readiness/draining, host incarnation, negotiated limits |
| Inventory | merged retained/managed sessions, bounded search/filter/page, host source |
| Session info | ID/name, generation/revision, residency/state, model/thinking, terminal outcome |
| Rich chat | normalized stable record IDs, markdown/thinking/tool/error/image blocks, composer |
| Pi commands | prompt/wake, steer, follow-up, abort, model/thinking, compaction/retry, bash where authorized |
| Session tree | bounded branch tree, active path/leaf, preview, capability-gated navigate/fork/clone |
| TUI | server snapshots/deltas, cursor/title, resize/input, controller role |
| New session | lazy draft, typed SessionSpec, exact first-send ticket, no eager runtime |
| Schedules | prompt-redacted list/status/editor/countdowns when advertised |
| Extensions | inert declarative views, correlated forms/actions, fallback for unsupported nodes |
| Diagnostics | bounded safe policy/error view only; never raw logs/prompts/paths/secrets |
| Export/ownership | explicit tickets, revisions/fingerprints, controller/authorization semantics |
| Settings | UI-only presentation/cache/editor/motion overlays; no service authority mutation |

### V0 trust model: tailnet + service bearer

Pi Droid v0 is a trusted-personal-tailnet client. It connects only to hosts the
operator registers, over Tailscale-reachable endpoints, and authenticates every
neutral HTTP/Rich/TUI operation with the existing Pi Daemon service bearer. The
bearer intentionally has full daemon authority. This is acceptable for the v0
internal-testing product and is shown clearly in host settings; it is not
presented as per-session or per-user isolation.

V0 does **not** add or block on mTLS, scoped mobile principals, device-key token
exchange, a mobile policy ledger, or a new authentication API. Tailscale limits
network reachability; the bearer remains the application credential. Use HTTPS
through Tailscale Serve/native TLS where configured, but do not design a second
mutual-TLS identity system. Explicit non-loopback HTTP works only when the daemon
operator has deliberately enabled the existing insecure transport override.

### V0 API sufficiency matrix

| Feature | Existing endpoint/wire | V0 authority/cache rule | Actual gap |
| --- | --- | --- | --- |
| capabilities/host | `GET /v1/capabilities` | full service bearer; no secret config cached | none |
| session inventory | `GET /v1/session`, neutral inventory | bounded per-host cursor and clearly labelled freshness | optional conditional change feed |
| session info | `GET /v1/session/{ref}` | full-authority operator may view current resource | optional reduced projection later |
| transcript preview | neutral Dashboard transcript | bounded app-private cache | none |
| Rich/TUI attach | framed RPC / TUI WebSocket | service bearer + explicit observer/controller role | none |
| wake/commands | framed Pi RPC | fresh preflight, controller, idempotency, indeterminate reconciliation | none |
| drafts/schedules/export | neutral Dashboard tickets | prompt/content input-only; ETag/ticket polling | none where advertised |
| workspace | Dashboard binary-split resource | Android tab-stack stays local in v0 | future schema decision |
| pairing | none | ASCII QR contains existing URL + bearer | CLI/QR implementation only, no server auth API |
| file/blob | bounded RPC images only | text/URL/fitting images | neutral generic blob API |
| background notifications | live attach / polling | best effort while visible/monitored | optional durable change/push feed |

## 5. Android repository and module architecture

The Android source lives below `android/` in Pi Daemon, while Node/web builds
remain unchanged.

```text
android/
  app/                         # com.harryaskham.pidroid application shell
  sdk-core/                    # transport, generated models, repositories, host/session identity
  sdk-session-ui/              # canonical Compose transcript/composer/TUI/info/tree views
  sdk-workspace-ui/            # tabs/splits/sidebar/workspace persistence
  sdk-android-integration/     # notifications, share receiver, widgets, floating-window adapters
  sdk-testing/                 # fake host, fixtures, clocks, network fault tools, screenshot fixtures
  build-logic/                 # convention plugins, release/signing policy
```

Dependencies point inward. `app` may depend on every SDK module;
`sdk-session-ui` depends on `sdk-core`; Cacophony can consume only the modules it
needs. No SDK module depends on the Pi Droid application or Cacophony.

### Publication for reuse

SDK artifacts should be versioned and published as AARs from Pi Daemon release
tags, for example:

- `com.harryaskham.pidroid:pi-daemon-core`
- `com.harryaskham.pidroid:pi-daemon-session-ui`
- `com.harryaskham.pidroid:pi-daemon-workspace-ui`
- `com.harryaskham.pidroid:pi-daemon-android-integration`

Local development may use a Gradle composite build. Cacophony production should
consume an immutable tagged artifact with checksums/provenance rather than copy
source or depend on a mutable checkout.

## 6. Host registration and QR pairing

### Manual registration

A host profile stores non-secret metadata:

- stable local `HostId` generated by Pi Droid;
- display name and optional color/icon;
- HTTPS/WSS base URL, or explicit loopback URL;
- optional TLS CA/pin metadata;
- expected Pi Daemon API major and optional host label;
- connection/background-monitor policy.

Bearer credentials are encrypted with an Android Keystore key and excluded from
Android backup, logs, analytics, screenshots, deep-link history, Room, DataStore,
and crash reports. Removing a host destroys the encrypted credential and cached
resources for that host.

Hosts are expected to be reachable only through the operator's Tailscale
network. HTTPS through Tailscale Serve or Pi Daemon native TLS is preferred.
Plain HTTP to a tailnet address is available only when the daemon operator has
explicitly enabled the existing non-loopback insecure override; Pi Droid shows a
persistent warning but does not add mTLS or another identity layer.

### Pair command

The desired operator flow is:

```console
pi-daemon pair --api-url https://host.example --name workstation
```

The CLI prints an ASCII QR code plus a short human verification code. Pi Droid
scans it, displays the endpoint/TLS identity/authority warning, tests
capabilities, and requires confirmation before saving.

Versioned v0 payload fields are deliberately simple:

```text
pairing payload version
API URL
host display hint
service bearer
optional TLS certificate/public-key fingerprint
```

The CLI reads bearer material from the existing owner-only source rather than an
argument and renders the QR directly to the user-present terminal. It warns that
anyone who scans/copies it has full daemon authority. Pi Droid previews the host,
URL, transport, and optional TLS fingerprint and requires confirmation before
saving/testing capabilities.

QR output is inherently visible terminal content, so the user must not include
it in screenshots, terminal recordings, support logs, or shared scrollback. The
CLI never emits it to structured logs or shell history. Pi Droid encrypts the
bearer with an Android Keystore key; ciphertext lives under `noBackupFilesDir`,
not Room/DataStore/backup. Restoring the app requires scanning again. Rotating the
server bearer invalidates every paired client, which is accepted v0 behavior.

Scoped/revocable per-device credentials may be considered after v0 if the app
leaves the trusted-personal-tailnet model. They are not a v0 protocol dependency.

## 7. Multi-host model and combined inventory

Every server resource/cache key is composite:

```text
HostId + bearerGeneration + hostInstanceId
+ sessionId/inventoryId + generation + revision
```

Rotating/removing a bearer or host purges that host's Room/query/transcript
partition. V0 has one full-authority subject per host and does not model scoped
principal/policy revisions.

Session IDs from different hosts never alias. Host clocks are not globally
canonical: combined activity ordering is labelled approximate when clock
uncertainty is unknown, or preserves each host's server order with a deterministic
host tie-break. It never claims one exact cross-host chronology.

Combined paging is a bounded fair k-way merge with one opaque cursor, snapshot
revision, normalized query digest, and exhaustion flag per host. Continuations
cannot starve a slow host. Tombstoning requires a complete successful authoritative
scan for that host/scope/query generation; partial pages and failed hosts never
remove rows. It supports:

- all-host and one-host views;
- saved filters, search, project/cwd/presence/model filters;
- host health and freshness chips;
- pinned and recent sessions;
- quick host switching without losing workspace state;
- partial success when one host is unavailable.

Host refreshes are independently bounded and rate-limited. One slow host never
blocks inventory from another. No query fans out without a configured concurrency
cap and cancellation when the UI no longer needs it.

## 8. Canonical cache and synchronization policy

Room stores bounded host/session/inventory/transcript/workspace metadata for fast
startup. Credentials never enter Room. Every cached resource carries:

- local `HostId`;
- last server `hostInstanceId`;
- session generation and resource revision/ETag;
- live sequence and opaque cursor when applicable;
- server/wall observation timestamp plus Android boot identity and
  `elapsedRealtime` sample;
- explicit freshness state and last safe error code.

A persisted monotonic value is never compared across reboot. On app/device boot
identity change all cached rows become stale until server revalidation. Sensitive
transcript/info caches are encrypted at rest with app-owned Keystore envelope
keys, live under no-backup storage, and enforce negotiated single-record plus
per-host/global count, byte, and age quotas. Bearer rotation or host removal purges
the corresponding host partition.

UI freshness states are first-class:

- **fresh/live** — response or live snapshot from current host incarnation;
- **reconnecting** — stream interrupted; cached content visible but marked;
- **stale** — freshness bound exceeded or host unavailable;
- **resyncing** — replay gap/generation/host change; old events discarded;
- **offline cached** — no current server authority; mutations disabled;
- **removed/tombstoned** — absent only after a successful complete authoritative
  reconciliation, never after a failed/partial page.

On host-instance or generation change, Pi Droid discards incompatible cursors,
events, controller state, and optimistic records, then waits for a fresh atomic
snapshot. Commands with a lost response are indeterminate and reconcile via
state/entries/tickets before any new idempotency key is considered.

Cached data may render instantly, but a prominent stale/offline indicator and
last-success age remain visible. Wake, prompt, stop, share, settings, and other
mutations require a successful fresh capability/session preflight and current
controller role. The app never updates cached state optimistically as though a
server mutation succeeded.

## 9. Session transport and UI state

`sdk-core` maintains at most one shared framed Rich attachment per
host/session/generation, fanning immutable state to multiple Android views. Each
view keeps a distinct subscription/command correlation. The transport owns:

- TLS/bearer auth;
- atomic attach and cursor replay;
- bounded reconnect with jitter;
- controller request/release;
- idempotent command correlation;
- replay-gap/full-snapshot transition;
- safe redacted diagnostics.

The reusable Stage C SDK lifecycle foundation keeps those mechanisms separated:
`PiDaemonClient` consumes exact advertised configured defaults and typed retained/
Dashboard resources, while `SessionLifecycleCoordinator` is a pure caller-driven
state machine. Every connection attempt, command correlation, request ID, and
idempotency key comes from the embedding app. Its process-resume snapshot retains
only host/session/generation/cursor and bounded operation identities/outcomes—no
bearer, cwd, prompt, transcript, command, result, or arbitrary error content.
Disconnect/process restoration makes unacknowledged commands indeterminate;
replay gaps clear the cursor and require an explicit fresh resync. It returns
attach/control/command actions for exact-once caller execution and never opens,
reconnects, or blindly replays on its own.

Configured creation never accepts an app-invented cwd: it maps the daemon's exact
Dashboard `sessionDefaults` to the durable Session API target. Existing managed
inventory is adopted only after exact retained-generation verification; external
inventory reuse is a capability-gated durable activation ticket. Observer attach
requires the transcript's exact current, available, non-quarantined authority.
`SessionLifecycleProjection` then maps the decoded inventory/info/transcript set
into the existing bounded readonly Rich state without reconstructing protocol
envelopes or gaining transport authority.

The canonical `SessionSurface` Compose component accepts a stable session key,
repository/transport interfaces, display policy, and optional host chrome. It
contains no Pi Droid navigation or Cacophony assumptions. It supports:

- Rich transcript and canonical TUI presentation without losing state;
- composer draft/history, Enter/Shift-Enter and hardware-key policies;
- controller/observer status and explicit control acquisition;
- tree navigation and session details;
- declarative extension views;
- reconnect/stale/offline/indeterminate states;
- adaptive phone/tablet/floating density.

Transcript rendering uses stable record keys and lazy virtualization. Markdown,
code, thinking, tool, and image blocks are parsed/reduced off the main thread.
Live streaming updates only affected records. A Rich/TUI switch preserves the
reading anchor as distance from bottom, matching Dash semantics.

## 10. Tabs, splits, sidebar, and saved workspaces

Android's workspace model extends Dash's binary split tree with tab stacks:

```text
WorkspaceNode =
  Split(axis, ratio, first, second)
  TabStack(activeTabId, tabs[])

Tab = id + title + LeafTarget
LeafTarget = session-rich | session-tui | session-info | hosts | diagnostics | empty
```

A split child may itself be a tab stack or another split, allowing arbitrary
split/tab combinations. Operations are pure and property-tested: split, tab,
move, close, merge, resize, focus, pin, duplicate, restore, and normalize.

Workspaces persist locally with schema version, revision, panel targets, selected
host/session keys, pane presentation state, geometry, and freshness-safe cursors.
Unknown future fields are ignored only where the version contract permits;
corrupt workspaces quarantine to safe defaults.

The Stage A `sdk-workspace-ui` checkpoint implements that local model as
serializable immutable JVM types with bounded pure transforms, deterministic v1
migration, seeded property tests, and corruption quarantine. Its stateless
Compose Desktop fixture consumes the same projection/reducer to prove adaptive
phone/tablet/foldable structure and accessibility without applying the Android
plugin or implementing a host, transport, or live session UI. Raw fixture images
are opt-in Cacophony session evidence, never product artefacts.

Phone UI projects the same model into one focused pane plus tab switcher. Tablet,
foldable, DeX/desktop, and external displays render multiple panes. A collapsible
sidebar becomes a drawer on narrow screens and supports combined-host inventory,
pins, schedules, and host state. Drag/drop and keyboard shortcuts are optional
presentation over the same deterministic model.

## 11. Notifications and Android lifecycle

Notification channels are user-controlled and content-safe:

- session completed/failed/stopped;
- waking/running activity;
- controller/input required;
- host disconnected/recovered/auth expired;
- scheduled session events where supported.

Prompt/model/tool content is hidden by default. Users configure channels,
per-host/session mute, quiet hours, importance, vibration/sound, and whether
lock-screen text is shown. Actions such as Open, Abort, or Follow Up appear only
when current authority and Android background rules permit; otherwise they open
the app for revalidation.

The current API has no durable per-host notification/change feed or push
registration. Initial notifications are explicitly **best effort** for visible
or foreground-monitored sessions. Periodic reconciliation cannot promise every
transition: Android WorkManager has a roughly 15-minute periodic floor/quotas,
and `lastTerminal` or inventory revision may be superseded by later activity.
Reliable completion notifications require a neutral host change token/event feed
(and optionally push registration) with durable cursor/dedupe;
FCM-specific server coupling is not assumed.

Initial lifecycle policy is concrete:

- visible app/floating window: live WebSocket connection;
- user-started pinned monitoring: `dataSync` foreground service, explicit
  persistent notification, maximum 8 monitored sessions, bounded reconnect,
  and a 6-hour maximum session before user renewal/clean stop to respect modern
  Android data-sync FGS limits;
- no boot auto-start, exact alarms, hidden restart loop, or permanent socket for
  unmonitored hosts;
- WorkManager catch-up uses the 15-minute periodic floor, network/battery
  constraints, bounded expedited quotas only for user actions, fresh server
  revalidation, and stale notification suppression;
- notification permission denial means no background foreground-service
  monitoring; visible-app monitoring still works and UI explains the limit;
- Doze/network loss marks notifications and cache stale rather than implying
  continued observation.

Notification dedupe identity includes local HostId, bearer generation, host
incarnation, session generation, and terminal/event ID. Actions revalidate session revision/controller
before mutation. Android 13+ permission, Android 14/15 foreground-service policy,
Doze, reboot, app update, logout, task removal, timeout, and user Stop must be
tested. Play policy review is a Stage-E gate; do not relabel a persistent socket
as `remoteMessaging` unless the app genuinely qualifies.

## 12. Floating windows and OS-level session surfaces

Pi Droid should consume android-utils' existing `floating-overlay` library rather
than create another overlay host. That library already provides:

- `TYPE_APPLICATION_OVERLAY` window ownership;
- `FloatContent` lifecycle;
- drag/resize, focus, minimize pill, dock, close;
- persistent titlebar and app-injected controls;
- geometry persistence and multi-window manager;
- dock-without-teardown semantics.

Pi Droid supplies a `ComposeView` or purpose-built session view as
`FloatContent`. A floating session keeps the same repository/attachment as its
docked view; docking reparents/re-presents without reconnect or losing composer,
scroll, tree, or controller state. Minimized views use bounded background policy
and never fake freshness.

The shared library should become a versioned android-utils AAR consumed from a
pinned repository/Maven artifact. Copying its source into Pi Droid would fork
the contract and is not the target. Local composite builds may map to the
android-utils checkout for development.

Overlay permission is explicit, optional, and explained. The foreground service
notification names active floats. Multiple floats are bounded; geometry is
clamped across rotation/fold/external display changes. Android background launch
limits are respected—no surprise overlay appears after boot or network events.

## 13. Widgets, shortcuts, and deep links

Jetpack Glance/RemoteViews widgets support selectable pinned sessions and hosts:

- compact status-only widget;
- transcript-tail widget with redacted/readonly default;
- interactive widget with Open, Wake/Follow Up, or Abort only after fresh
  revalidation and explicit opt-in;
- multi-session stack/collection widget.

Every widget shows host and freshness/age. Event-driven updates occur after app
repository changes, with bounded WorkManager catch-up; widgets never claim live
state from stale Room rows. Widget state survives process recreation without
storing credentials in widget preferences.

Dynamic shortcuts and `pidroid://host/<id>/session/<id>` app-owned deep links
open saved local identities only. Bearers and raw remote URLs never appear in
external deep links.

## 14. Android Share API and file transfer

Pi Droid registers `ACTION_SEND`, `ACTION_SEND_MULTIPLE`, text/URL, image, and
bounded document MIME intents. The chooser lets the user select host, session,
optional message, and whether to send immediately or open a draft.

Android URI grants are untrusted and often ephemeral/non-persistable. Pi Droid
must consume/copy the stream during the grant lifetime into encrypted bounded
`noBackupFilesDir` staging, count actual bytes when provider size is unknown,
sanitize display name/MIME, persist a content hash rather than the URI, and
clean staging after cancel, failure, process death, or TTL. WorkManager never
receives an expired URI. Streaming shows progress and never allocates the whole
file.

### Existing support

Pi RPC prompt/steer/follow-up supports at most 32 `ImageContent` items and its
type permits each base64 data string up to 16 MiB, but that is not a universal
usable image size. Effective send capacity is the minimum of image-union bounds,
negotiated WebSocket/frame/body/per-reader-outbound limits, with base64 overhead
included (Dashboard frames default to 1 MiB). Android computes the encoded size
before admission. Text/URLs and only images that fit every negotiated bound are
the MVP. This is not generic file transport.

### Required neutral API gap for files

Pi Daemon currently has no mature generic client-to-host blob/file upload route.
Production document sharing needs a core, client-neutral feature, for example:

- bounded streaming upload ticket with declared size/MIME/name/SHA-256;
- owner-private content-addressed blob store with TTL/quota/reference count;
- content policy for allowed MIME/types, archive handling, optional operator
  scanning/quarantine hooks, and safe rejection without executing/parsing active
  content in the daemon;
- upload/reference authorization requires the service bearer plus exact host,
  session and generation; cross-session blob reuse requires explicit action;
- no path supplied by the client and no implicit tool authority;
- resumable/cancelable upload where feasible;
- session command references authorized blob IDs rather than raw network paths;
- explicit materialization policy into a session-owned inbox, or image prompt
  conversion where supported;
- audit-safe metadata, idempotency, and indeterminate reconciliation;
- download/preview authorization and cleanup.

This must be specified and implemented as a main Pi Daemon protocol feature with
schema/OpenAPI/fixtures/JS client tests, then consumed by Android and web. The
Android MVP may share text/URLs and bounded supported images; generic files stay
disabled with honest UI until this lands.

## 15. Cacophony Android integration

Cacophony embeds Pi Droid SDK components through transport injection, not a
credential getter exposed to reusable UI code:

```kotlin
interface PiDaemonTransport {
    val hosts: Flow<List<PiDaemonHostDescriptor>>
    suspend fun execute(host: HostId, request: NeutralHttpRequest): NeutralHttpResponse
    fun openWebSocket(host: HostId, request: NeutralWebSocketRequest): PiDaemonSocket
}
```

The embedding app owns authentication, TLS, credential lifetime, and request
factories. SDK UI sees only neutral responses/events and never requests or
exports Cacophony-held bearer bytes.

Cacophony may connect directly or provide an app-private bridge. Localhost TCP
alone is not an Android security boundary because other apps can connect. A
bridge must use non-exported Binder with caller UID checks, an app-private Unix
socket, or a per-process unguessable short-lived capability additionally bound
to UID; it is bounded, revoked on process/lifecycle change, and never an exported
component. Direct mode likewise keeps machine bearer authority out of UI modules.

Pi Droid and Cacophony keep separate Android sandboxes, Room databases, Keystore
keys, no-backup stores, and app backups. No `sharedUserId`, cross-app credential
copy, or implicit cache migration. Cacophony descriptors may map into neutral
`HostDescriptor`, but no agent/bead/profile/message value enters `sdk-core`.

Published AARs require stable resource namespaces, explicit Compose/Kotlin and
BOM compatibility policy, consumer ProGuard/R8 rules, API/ABI binary-compatibility
checks, and versioned migration notes. Adoption is incremental: readonly session
view, controller interaction, workspace, then share/widgets/floats. Existing
Cacophony UI remains until parity and screenshot/device acceptance pass.

## 16. Performance and visual quality

- Kotlin, coroutines/Flow, immutable models, Jetpack Compose/Material 3.
- OkHttp WebSocket/HTTP transport with one bounded dispatcher per host group.
- Room writes and protocol parsing off main thread; batched transactions.
- Lazy transcript/tree/inventory lists with stable keys and bounded prefetch.
- Streaming JSON/frame parsing within negotiated limits.
- Baseline Profile and Macrobenchmark modules for release measurements.
- Cold startup renders cached-but-labelled inventory quickly, then reconciles.
- Network shaping tests cover latency, loss, disconnect, captive portal, host
  restart, replay gap, and generation replacement.
- Adaptive Nord-derived visual system with excellent dark/light contrast,
  typography, spacing, motion reduction, TalkBack, switch access, large text,
  keyboard, mouse, stylus, and fold posture support.

Performance numbers are opt-in benchmark acceptance, not load-sensitive standard
CI assertions. Standard tests prove deterministic bounds, virtualization, cache
sizes, event coalescing, and cancellation.

## 17. Security and privacy

- HTTPS/WSS or explicit loopback by default; remote plaintext denied.
- Keystore keys encrypt/sign; bearer ciphertext lives only under no-backup app
  storage, partitioned by HostId/bearer generation, excluded from backup/logs,
  and becomes unusable after restore without fresh pairing.
- Sensitive Room transcript/info rows are encrypted at rest, quota-bounded, and
  purged on credential/policy/revocation changes.
- Optional biometric gate for opening credentials or controller actions.
- Certificate/pin changes require explicit re-pair confirmation.
- No prompts, transcript text, bearer, file contents, canonical paths, or
  environment values in analytics/crash reports.
- Screenshots/recents privacy is per-host/session setting; sensitive sessions may
  request `FLAG_SECURE` locally.
- Clipboard actions are explicit and show content origin.
- Host removal revokes local credentials/cache; daemon credential rotation is
  re-paired explicitly.
- The Android Hosts surface remains reachable after failed startup and supports
  zero/one/many hosts, durable default selection, non-secret metadata edits,
  explicit atomic credential replacement, and confirmed per-host removal. A
  duplicate endpoint routes to the existing host's re-pair flow rather than
  being ignored. Replacement commits metadata plus a staged Keystore generation
  before invalidating that host's sockets/cache or making any request; failed
  commits roll back the staged generation. Other hosts and workspace references
  remain intact, while missing-host views offer selection or re-registration.
- Pairing/file/background endpoints, if added, retain auth-before-routing and
  content-free absent/unauthorized parity.

## 18. Signing, SOPS, and Play distribution

No plaintext key material enters git, logs, Gradle properties, Nix store, or
artifacts.

Preparation copies/adapts only the encrypted Android release material and SOPS
policy pattern from android-utils:

- `.sops.yaml` recipients for Harry, Caco, and Caco Work;
- `secrets/android-play-upload.sops.yaml` encrypted fields;
- `secrets/README.md` public handling/fingerprint contract;
- audited temporary-file materialization/cleanup script in the later release
  implementation;
- Play service account upload tooling in the later release implementation.

The encrypted file and recipient policy are now present. An operator-authorized
private temporary verification on 2026-08-03 confirmed the copied release
certificate SHA-256 exactly matches:

`FA:58:80:A7:C9:6D:F8:7B:B4:63:7D:18:58:7E:32:F6:CD:F6:95:06:52:34:FE:54:95:E2:4F:ED:12:1E:CE:4C`

A mismatch stops release; do not create a replacement key after Play
pre-registration. The package/application ID is fixed to
`com.harryaskham.pidroid`.

### Hermetic Pi/npm dependency prerequisite

Pi Daemon main `fc14511` (`bd-94a9d2`) exposes the exact fixed-output npm cache
as `packages.<system>.npm-deps`. Android tag/nightly workflows that also need the
Pi Daemon Node package use this contract instead of redownloading registry state:

```console
nix build .#npm-deps
nix build --offline .#npm-deps
```

The offline build is the proof that the cached dependency closure is registry
independent. First materialization retries at most three times and only for the
reviewed curl-92/framing/timeout/DNS/connection/HTTP-502-to-504 transport
classes, with typed tarball, attempt, backoff, and cleanup receipts. Integrity,
identity, lock, HTTP/2 404, and unknown failures are immediate. The full Pi
Daemon package consumes the same path, fetcher version 2, and unchanged recursive
hash. Android app dependencies remain separately locked by Gradle/Nix; this
prerequisite does not make ordinary Android PR CI build the Node package.

### CI lanes

**Normal PR/main (fast, Android paths only):**

- Gradle/settings/configuration and dependency-lock checks;
- Kotlin formatting/static analysis;
- pure JVM protocol/cache/workspace tests;
- generated protocol fixture compatibility;
- no emulator, signed release AAB, Play upload, or full Android SDK build in
  ordinary Pi Daemon gates.

**Nightly/manual integration:**

- pinned Nix Android SDK/emulator;
- phone/tablet/foldable profiles;
- fake and real disposable Pi Daemon hosts;
- Compose screenshot/golden tests;
- networking/Doze/process-death/widget/notification/share/floating-window tests;
- Macrobenchmark and Baseline Profile generation;
- no Play upload.

**Pi Daemon stable tag:**

- validate stable tag and Android versionCode/versionName policy;
- build release AAB in pinned Nix/Gradle environment;
- verify package ID/signing certificate/AAB integrity/provenance;
- retain AAB, mapping, checksums, dependency/SBOM metadata;
- upload idempotently to Google Play `internal` track for the configured internal
  testers;
- no auto-promotion beyond internal;
- failed upload keeps artefacts and safe diagnostics for operator retry.

VersionCode must be monotonic and explicit. A deterministic mapping from stable
Pi Daemon semver may be used only with tested range/overflow policy; otherwise a
committed Android release counter is bumped as part of the tag preparation.

The first internal fixture release was uploaded on 2026-08-03 as
`com.harryaskham.pidroid` version code 1 (`0.3.0-internal.1`) with the exact
preregistered certificate. Play verification edit `11366480557777285731`
confirmed completed release 1 on `internal`; the uploaded AAB SHA-256 is
`d9b2e9fb569bb936d81764eeb5d16b21ce49a9ad810e63dfb6f5ba0ebc2144c3`.
Bundletool manifest inspection confirmed the early fixture app requests no
`INTERNET` permission. This proves signing, packaging, emulated install and the
internal delivery path only.

The second internal release was uploaded on 2026-08-04 as version code 2
(`0.3.0-internal.2`). It adds reviewed `INTERNET` authority, manual/ASCII-QR host
registration, Android-Keystore/no-backup bearer storage, bounded OkHttp HTTP and
observer WebSocket transport, and live readonly inventory/info/transcript UI.
Disposable ApiServer proof crossed emulator `10.0.2.2`, then captured offline
cache and a different host incarnation after restart with no prompt/controller
operations or bearer leakage. Fresh Play verification edit
`02117095949443938631` confirmed completed version 2 on `internal`; uploaded AAB
SHA-256 is `72adf5bacefac22c1569d2b7579b547d4f48c28881808e4f7036fde6560331aa`.

The fourth internal release was uploaded on 2026-08-09 as version code 4
(`0.3.0-internal.4`) from exact app source commit
`aab5afb39de8e9e7071320268a56eb703d0f0306`, tree
`daf8cf9e639da11b6cba4d1fc072e1f6c64c5ac6`. It includes resilient reconnect
and host recovery, canonical bearer connections, retained app-failure modal
evidence, the reviewed external-canary contract, a clear
transcript-unavailable state, and editable/forget/re-pair crash-safe multi-host
management. Create/adopt daily-driver polish remains in progress. Immediately
before upload, verification edit `17487365761742315051` confirmed version 3 as
the existing highest internal release. After the internal-only completed upload,
verification edit `08236353605814851857` confirmed version 4 as highest on
`internal`, preserving versions 1–3. The uploaded AAB SHA-256 is
`f09a810c501e900011ebaa4c6fb0eb8039abbefabece2a9a1d045843b8029775`; R8 mapping
SHA-256 is
`deae7b97e8ba575c9aee40523787d895a30fd8e046b33f1de54b9328fb3dfa21`; published
release-notes SHA-256 is
`ea638b8eb891399e5a31d88000b9f1f7451a18641fd43139d173c581ca9b0387`.

The fifth internal release was uploaded on 2026-08-09 as version code 5
(`0.3.0-internal.5`) from exact app source commit
`0e781580a2c76cce11d98ed06c109c385123ae89`, tree
`dd2c8b1ee6778d1b32ab5314a7e094127d2a0ad8`. It includes crash-safe editable,
forget and re-pair multi-host management; create/adopt sessions; observer,
control, wake and stream lifecycle; process-death restoration that marks
accepted work indeterminate without replay; and the restored accessibility
label. Immediately before preparation, verification edit
`12484767714633664694` confirmed version 4 as the existing highest internal
release. After the one internal-only completed upload, verification edit
`13111413071479325735` confirmed version 5 as highest on `internal`, preserving
versions 1–4. The uploaded AAB SHA-256 is
`ed0cdb20c877cac3a8990cb007b8c47df109e06e7091f90d63817d54a7392994`; R8 mapping
SHA-256 is
`84077c0a2ec2c549d45a8e30d8001aec10fa8a36fbea556f79703fd5c0d89fd0`; published
release-notes SHA-256 is
`0c5ac7031968f70cae46300b032e942becdb8b488b05097eb4b6beeeeb1d8d08`.

The sixth internal release was uploaded on 2026-08-09 as version code 6
(`0.3.0-internal.6`) from exact merged UX source commit
`4febafe56440eb57e9366dfe2fc591960dd7d78a`, tree
`595a139e555b53ee4c43100428d4e0b40abd87f2`. It publishes the `bd-8e2c2a` UX
pass: screenshot-tested phone/tablet/wide adaptation, deterministic secure
endpoint assessment, focused onboarding and host/session hierarchy,
search/filter/recency inventory, explicit loading/empty/error/retry/offline,
role/freshness/action and accessibility truth, Transcript/Tree/Terminal/
Extensions navigation, dynamic color fallbacks, safe Back/IME behavior, and
named TalkBack controls with 48 dp targets. Every preview 5 daily-driver
multi-host, session, observer/control/wake/stream, process-restoration and
no-replay flow remains present. Immediately before upload, verification edit
`11448386855268785244` confirmed version 5 as the existing highest internal
release. After the sole internal-only completed upload, verification edit
`10109755456501727230` confirmed version 6 as highest on `internal`, preserving
versions 1–5. The uploaded AAB SHA-256 is
`792bc5a2e831e6a69d81e377c6ee6c761fbbdf9ab42fcfa7e54f2db33b0395bf`; R8 mapping
SHA-256 is
`ce8bc95b5ab24c4b195ade9e2e66aa156c2544561bdc37d94c9500b2627311af`; published
release-notes SHA-256 is
`5189d50a08e3386df9d5e0e8c755d9429db89b64f8e3a66548d260dbff7c39bd`.
The shared fixture and full UX contract are documented in
[`pi-droid-ux.md`](pi-droid-ux.md). External-canary proof was not invoked by
this release.

## 19. Testing and acceptance

### Deterministic tests

- generated schema/OpenAPI/fixture round trips and unknown-field compatibility;
- host/session composite identity and multi-host merge ordering;
- cursor/replay-gap/generation/host replacement;
- stale/offline UI and mutation refusal;
- workspace split/tab property tests and migration/corruption recovery;
- transcript reducer idempotency, tool replacement, and branch identity;
- controller lease and indeterminate command handling;
- configured-default creation, retained adoption, durable ticket identity and
  evidence-backed reconciliation against an isolated disposable real daemon;
- process restore with unique connection/correlation identity, stale-attempt
  rejection, replay-gap resync, and permanent no-replay semantics;
- daily-driver phone/tablet/wide/large-text adaptive policy, endpoint security,
  search/filter/recency, named Compose semantics, and minimum touch targets;
- secret/log/crash redaction;
- notification dedupe/freshness/quiet-hours;
- QR payload bounds/expiry/replay;
- share size/hash/cancel/URI permission behavior;
- widget stale labels and process recreation;
- floating geometry/focus/dock/minimize lifecycle.

### Device/integration tests

- app process death and reboot;
- host restart, TLS failure, token rotation, network switching, Doze;
- multiple hosts with partial outage;
- concurrent panes for one session and controller handoff;
- local Android-hosted daemon reached through loopback;
- Pi Droid and Cacophony embedding the same SDK session fixture;
- Surface Duo/fold posture, tablet, phone, DeX/external display;
- overlay permission denied/granted/revoked;
- Play internal install/update and encrypted credential persistence;
- reviewed external-canary debug install using a canonical API origin and an
  owner-only token file, with a readiness-first GET-only preflight, exact
  host/session fencing, bounded shell-v2 no-PTY ADB stdin staging whose remote
  mode, size, and digest are verified before app launch, idle-only observer
  attach, no target-daemon lifecycle or mutation, and zero run-owned
  emulator/ADB/process/port residue.

### Visual proof contract

Every major stage supplies screenshot proofs through Cacophony's image/session
artifact surface, not only Gradle reports. The app-shared daily-driver fixture
writes deterministic phone, tablet, wide, large-text, and generated contact-sheet
PNGs for source review; release acceptance still uses the exact tested APK/AAB.
Required sets include:

- phone/tablet/foldable combined inventory;
- arbitrary tabs-in-splits and splits-in-tabs;
- Rich/TUI/tree/extension views;
- fresh/reconnecting/stale/offline/resync/indeterminate states;
- host registration and QR confirmation;
- notification drawer, widgets, Android share target;
- floating/minimized/docked session windows;
- Cacophony app embedding the canonical SDK session view.

Use device screenshots from the exact tested APK/AAB. Contact sheets should be
roughly square and split when dense; include raw named screenshots for detailed
inspection. Screenshot review is a release gate, not decoration. External
canaries are the exception to content-bearing screenshot evidence: their
reviewed debug-only screen renders content-free readiness, hydration, observer,
and no-mutation markers while the session projection remains hidden. The bearer
must remain absent from intents, argv, environment, stdout/stderr, logs,
screenshots, backup, and retained artifacts; exact-value and structured-pattern
scans run on every exit.

## 20. Delivery stages and gates

No broad parallel implementation starts until the plan, encrypted key material,
and parent bead/dependency graph are approved.

### Stage A — contracts and project skeleton

- Android Gradle/Nix module skeleton and generated protocol models;
- neutral transport/client conformance against fixtures;
- SDK module boundaries and Cacophony embedding sample contract;
- signing/SOPS files encrypted and certificate verified;
- fast/nightly/tag workflow skeletons;
- trusted-tailnet host registry and full-authority service-bearer storage;
- `pi-daemon pair` QR payload/terminal UX and Android scan confirmation.

Gate: no UI claims; protocol generation, bearer secrecy-at-rest, tailnet host
registration, and secret-safe build configuration pass. No new auth protocol is
required for v0.

### Stage B — single-host readonly canonical client

- manual and QR host registration with the existing service bearer;
- capabilities, inventory, info, preview transcript;
- host-partitioned app-private Room freshness states and offline labels;
- readonly Rich session view.

Gate: full-authority host status is visible; cache can never cross host/bearer
rotation or appear live after host/generation/reboot change; screenshot set.

### Stage C — interactive live session

- framed attach, replay, controller lease;
- composer/Pi commands, tree, TUI, extension views;
- notification basics while visible/monitored.

Gate: wake/steer/follow-up/abort exactly match Pi RPC semantics under reconnect.

### Stage D — workspaces and multi-host

- recursive split/tab model and saved workspaces;
- collapsible adaptive sidebar;
- combined multi-host inventory and partial outage;
- stable-bearer ASCII QR pairing and host verification UX.

Gate: property tests, large-session performance, phone/tablet/foldable proofs.

### Stage E — Android OS integration

- foreground monitored-session service and notifications;
- widgets, shortcuts, deep links, Share text/images;
- android-utils floating-overlay integration.

Gate: process-death/Doze/overlay/widget/share physical-device acceptance.

### Stage F — generic file transfer and Cacophony SDK adoption

- neutral Pi Daemon blob/file API if approved;
- Android Share file streaming;
- Cacophony readonly then interactive canonical views;
- direct and bridge endpoint modes.

Gate: no Cacophony dependency in SDK; cross-app fixture parity and screenshot proof.

### Stage G — internal release

- performance/accessibility/privacy hardening;
- release signing and certificate proof;
- stable-tag AAB workflow;
- Google Play internal rollout, install/update smoke, rollback notes.

Gate: full release evidence, no unresolved P0/P1, operator approval.

## 21. Protocol/API decisions required before bead expansion

1. Confirm the v0 tailnet host URL conventions (Tailscale Serve HTTPS preferred,
   explicit daemon insecure override accepted where Harry chooses plain tailnet
   HTTP) and final QR payload version.
2. Define the neutral blob/file upload/content-policy contract and whether it
   blocks Stage E document sharing or only Stage F.
3. Decide whether reliable background completion notifications require a neutral
   durable event/change cursor and optional push registration; until then all
   notifications are best-effort under the explicit dataSync/WorkManager policy.
4. Select SDK artifact publication (GitHub Packages, repository Maven, or another
   immutable channel) and Cacophony transport-injection strategy, including
   private Binder/Unix bridge requirements.
5. Decide whether Android workspaces stay local or later synchronize through the
   existing server workspace resource; Android's tab-stack extension must not be
   written into a server binary-split schema without a versioned protocol change.
6. Confirm initial minSdk/targetSdk and Play foreground-service policy. The
   existing floating-overlay library supports minSdk 26/Java 17; Pi Droid should
   target current Play requirements.
7. Verify the supplied encrypted key's certificate fingerprint before creating
   any Play artifact.

Post-v0 only: revisit scoped/revocable client identities if Pi Droid leaves the
trusted-personal-tailnet model. This is not a prerequisite for v0 beads or release.

## 22. Bead-expansion rule

After operator review of this document:

1. file one parent epic for Pi Droid;
2. file stage/gap/security/distribution beads with explicit dependencies and
   acceptance copied from this plan;
3. copy/adapt encrypted SOPS material and verify metadata/fingerprint before
   dispatching implementation;
4. assign only non-overlapping Stage A slices to the dedicated Aurora Pi Daemon
   workers;
5. keep protocol gaps in main Pi Daemon beads, Android modules in Android beads,
   and Cacophony adoption in downstream Cacophony beads;
6. require every implementation bead to name its screenshot/device proof.

Until those steps are complete, no Android application implementation should be
dispatched.
