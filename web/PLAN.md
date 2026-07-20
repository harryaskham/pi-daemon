# Pi Daemon Dash — product and implementation plan

Status: **implemented through live browser integration; final v1 acceptance remains**
Product name: **Pi Daemon Dash**  
CLI surface: `pi-daemon web`  
Configuration namespace: `web:`  
Initial UI: self-contained single-page application (SPA)

## 1. Purpose

Pi Daemon Dash is a browser interface for inspecting and interacting with Pi
sessions through Pi Daemon. It is distributed in the same npm/Nix artifact as
Pi Daemon and supports two server deployments:

1. **Embedded** — the dashboard HTTP server runs in the Pi Daemon process and
   calls transport-neutral daemon services directly.
2. **Dedicated** — `pi-daemon web` runs the same dashboard server in a separate
   process and reaches Pi Daemon through its authenticated HTTP/WebSocket API.

Both modes serve the same browser protocol and the same compiled SPA. The SPA
must not contain mode-specific behavior, and the dashboard server must not
implement two independent session state machines.

The default experience is:

- a searchable, expandable, recently-updated session sidebar appears quickly;
- clicking a session paints its persisted transcript immediately;
- runtime hydration proceeds in parallel and never sends a model turn;
- when ready, the pane receives live Pi events over WebSocket;
- submitting text runs one normal Pi agent run, including any number of LLM
  turns and tool calls, until Pi emits `agent_settled`;
- after settlement the SDK runtime is idle and consumes no model/tool compute;
- resident idle sessions remain warm for a bounded period and are then safely
  evicted back to durable state; and
- multiple chat or information views can be arranged in a persistent tree of
  horizontal and vertical split panes.

## 2. Product boundaries

Dash remains part of the standalone Pi Daemon product. It may model Pi session
files, Pi SDK events, daemon session resources, generic schedules, and browser
workspace state. It must never import or model Cacophony beads, agents,
profiles, node state, messages, credentials, or lifecycle internals.

A future Cacophony client may use neutral Pi Daemon APIs or project its own
information into a separately specified extension point. That does not make
Cacophony a dependency of Dash.

A shared Pi Daemon process remains one trust domain. Dash does not make trusted
extensions, tools, or project resources sandboxed.

## 3. Current facts and corrected assumptions

The design depends on the following current Pi 0.80.6 and Pi Daemon behavior.
These are constraints, not implementation details to wish away.

### 3.1 Pi sessions

- Pi persists sessions as versioned JSONL trees under its session directory.
- `SessionManager.listAll()` returns path, Pi session ID, cwd, name, parent,
  created/modified dates, message count, first message, and searchable message
  text.
- `SessionManager.open()` parses a session without sending a model request.
- Entries include messages, model/thinking changes, compactions, branch
  summaries, labels, custom messages, custom extension state, and session-name
  changes.
- The current leaf defines the active branch. A transcript renderer must not
  flatten every branch into one false linear conversation.

### 3.2 Pi Daemon sessions

- Pi Daemon currently lists only its durable catalog, not every JSONL file in
  `~/.pi/agent/sessions`.
- Pi Daemon currently stores hosted conversations under
  `STATE_DIR/sessions/<daemon-session-id>/pi`, separate from the Pi credential
  directory, and path policy rejects direct use of the global Pi session root.
- Pi 0.80.6 appends JSONL records without a cooperative file lock. Opening the
  same file in two stock Pi processes is possible, but it can produce stale-leaf
  branches, interleaved writers, or silent divergence; UUID uniqueness does not
  solve concurrent writes to one file.
- Therefore “every Pi JSONL is already lazily loadable by Pi Daemon” is not yet
  true. Dash adds a read-only inventory and explicit session ownership modes.
- New Dash/daemon conversations should be configurable to use the normal Pi
  session root by default, making them immediately visible to stock Pi. The
  session-data subdirectory becomes a narrowly permitted root without granting
  access to sibling auth/config files.
- Opening an existing JSONL offers **co-opt/direct** and **fork/import** modes.
  Direct mode is an explicit trust decision with best-effort live-writer checks
  and ongoing fingerprint conflict detection. Fork/import is the safe fallback
  and remains available even when another Pi appears live.
- A daemon-owned fork can later be exported back to the normal Pi session root.
  Export-as-new is safe by default; updating the original requires strict
  unchanged-prefix/fingerprint and no-known-writer checks.

### 3.3 Runtime and eviction

- Attaching to a dormant managed session currently hydrates its
  `AgentSessionRuntime`.
- Pi Daemon already has an idle-session TTL, currently 30 minutes by default.
- A runtime is `running` through retries, compaction recovery, queued
  continuation, and tool execution. `agent_settled`, not merely `agent_end`, is
  the terminal “no automatic work remains” signal.
- An idle resident runtime performs no agent work, but retains SDK, resource,
  extension, settings, and parsed conversation state in memory.

### 3.4 Browser and shadow-TUI rendering

Pi's terminal components are not DOM components, but Pi TUI has a useful seam:
`TUI` accepts a `Terminal` interface. A memory terminal with mutable rows/columns
can receive Pi's ANSI differential output and project it into a virtual cell
grid. This supports a second per-pane presentation mode:

1. **Rich web** — browser-native semantic transcript, tools, chips, composer,
   panes, and extension UI adapters.
2. **TUI embed** — a monospaced virtual Pi TUI whose rows/columns track the web
   pane and whose styled cell runs are rendered interactively in the browser.

There are two current limitations to solve honestly:

- `InteractiveMode` hardcodes `new TUI(new ProcessTerminal())`, installs
  process-global terminal/signal behavior, and does not accept an injected
  terminal today.
- An `AgentSession` currently has one extension UI binding. Running an unrelated
  shadow `pi` process would duplicate runtime/extension state and reintroduce
  concurrent session writers.

The preferred implementation is therefore **not** a child-process PTY. It is a
`ShadowTuiHost` in the daemon using an injected `VirtualTerminal`, plus a small
upstream Pi seam (or a reviewed extraction of `InteractiveSessionView`) so one
resident runtime and extension instance can drive the virtual view. The daemon
parses ANSI into bounded styled row deltas; the browser does not evaluate
extension JavaScript.

The completed `bd-2756e4` spike now provides the bounded `VirtualTerminal`,
headless styled row-delta projection, strict side-channel stripping, exported Pi
message/tool/custom/overlay/editor fixtures, and measured full/delta/resize
receipts. Full `ctx.ui.custom()`, component widgets, custom editors, and
keyboard interaction still require the documented `InteractiveSessionView`
terminal/lifecycle/external-extension-binding seam; Pi 0.80.6 continues to
hardcode `ProcessTerminal` and re-emits `session_start` on `bindExtensions()`.
Rich web remains available while that small upstream seam is pending.

### 3.5 Configuration

Pi Daemon is currently configured primarily by `pi-daemon serve` CLI flags:
required socket/allowed roots plus state, agent, limits, API, and auth-source
flags. Its Home Manager module renders those flags and a small non-secret
process environment. Environment variables are not the general configuration
surface; the service bearer has one environment fallback.

Dash adds a bounded YAML loader following the desired Pi family convention:

```text
~/.config/pi/daemon/<instance>/config.yaml
```

The default instance is `default`; `--config PATH` and `PI_DAEMON_CONFIG` select
a different file. CLI flags override YAML, while Home Manager may generate or
point at a non-secret YAML file. Secret values remain file/fd references. This
is a new contract, not merely a `web:` field in an existing loader.

## 4. Product principles

1. **Preview before hydrate.** Reading a transcript must not need provider auth,
   extension loading, or a resident SDK runtime.
2. **One behavioral core.** Embedded and dedicated backends satisfy one typed
   interface and one conformance suite.
3. **Server authority.** The browser is a cache and presentation client, never
   the source of truth for sessions, acknowledgement cursors, configuration, or
   workspace layout.
4. **No prompt on open.** Previewing, hydrating, attaching, splitting, and
   inspecting a session never submit an agent turn.
5. **Explicit control.** An observer does not silently become a controller, and
   a dashboard never steals an occupied controller lease.
6. **Fast bounded reads.** Inventory, JSONL parsing, transcript projection,
   stream replay, browser caches, and resident sessions are all bounded.
7. **Secure browser boundary.** The service bearer is never exposed to
   JavaScript or persisted in browser storage.
8. **Two truthful renderers.** Rich-web components consume normalized Pi records
   and semantic theme tokens. TUI panes consume a bounded server-side virtual
   terminal grid; raw ANSI never becomes unsanitized HTML.
9. **Truthful liveness.** Running, resident-idle, dormant, scheduled, failed,
   and unread are separate facts. A single overloaded boolean is forbidden.
10. **Additive protocol evolution.** New inventory, preview, ownership/export, and Dash
    routes require TypeScript types, JSON schema/OpenAPI where public, fixtures,
    compatibility tests, and documentation.

## 5. Deployment modes

### 5.1 Embedded mode

`pi-daemon serve` constructs `DashboardServer` with an
`InProcessDashboardBackend`. The backend receives references to neutral core
services such as the session inventory, mutation admission service,
`Multiplexer`, and RPC attachment/controller service.

It must use the same validation, scheduling, generation, idempotency, controller
lease, serialization, and event sources as external clients. “In process” is an
optimization, not permission to bypass policy.

Provisional defaults:

- enabled by default after the browser-auth bootstrap is implemented;
- bind `127.0.0.1`;
- API port `7463` when configured;
- embedded Dash port `7464` (`apiPort + 1` by convention);
- owner-private generated web login token when no external source is supplied.

### 5.2 Dedicated mode

`pi-daemon web` constructs the identical `DashboardServer` with a
`RemoteDashboardBackend`:

- REST calls use the existing bounded `SessionApiClient` family;
- live sessions use `pi-daemon-rpc.v1` framed WebSockets;
- the daemon service bearer is loaded by the server process from an owner-only
  file/fd/environment source and never sent to the browser;
- dashboard browser authentication remains separate from daemon API
  authentication; and
- reconnect, replay gaps, generations, controller roles, and indeterminate
  commands retain their existing meanings.

Provisional dedicated port default: `7465` (`apiPort + 2`, one after the
embedded convention). Every port remains explicitly configurable and Home
Manager must assert collision freedom across instances.

The additional local hop should normally be sub-millisecond to a few
milliseconds and is not expected to be materially slower than provider work.
The dedicated mode exists for lifecycle/failure isolation, not performance.

### 5.3 One browser protocol

The browser always talks to `DashboardServer` over the same `/dash/v1` HTTP and
WebSocket contract. It never speaks directly to the daemon's service-bearer API.
This provides:

- identical SPA code in both modes;
- no service bearer in browser memory;
- no browser CORS dependency on the daemon API;
- one place for workspace persistence, browser authentication, CSP, and
  transcript projection; and
- one place to coalesce multiple panes watching the same daemon session.

## 6. Runtime architecture

```text
Browser SPA
  ├── /dash/* immutable static assets
  ├── /dash/v1/* bounded JSON resources
  └── /dash/v1/stream authenticated WebSocket
                     │
                     ▼
              DashboardServer
  ├── browser auth + Origin/CSRF boundary
  ├── workspace/layout/settings stores
  ├── transcript projection/cache
  ├── per-session channel coalescing
  └── DashboardBackend interface
          │                             │
          ├── InProcessDashboardBackend ├── RemoteDashboardBackend
          │       direct service calls  │       daemon REST + framed RPC WS
          └──────────────┬──────────────┘
                         ▼
       inventory / mutation admission / Multiplexer / PiRpcController
                         │
                         ▼
                 Pi AgentSessionRuntime
```

The core implementation should be split into these modules:

- `SessionInventory` — discovers and indexes managed and external Pi sessions.
- `TranscriptProjector` — converts a versioned Pi JSONL tree to bounded,
  renderer-neutral transcript records.
- `SessionOwnershipService` — opens, co-opts, forks/imports, exports, and
  conflict-checks Pi JSONL files under explicit session-storage policy.
- `DashboardBackend` — behaviorally complete embedded/remote backend interface.
- `DashboardServer` — browser HTTP/WS, auth, settings, workspace, and static
  assets.
- `DashboardSessionChannel` — one coalesced snapshot/event/controller channel
  per daemon session, shared by all local panes.
- `ShadowTuiHost` — optional in-process virtual terminal/TUI view, cell-grid
  projection, resize/input broker, and dedicated-backend transport.
- SPA packages — shell, session list, split workspace, transcript, TUI grid,
  composer,
  metadata, settings, theming, and reducers.

## 7. Backend contract

The exact TypeScript shapes will be versioned, but the server-side interface
must express at least:

```ts
interface DashboardBackend {
  capabilities(): Promise<DashboardCapabilities>;

  listSessions(query: SessionInventoryQuery): Promise<SessionInventoryPage>;
  getSessionInfo(inventoryId: string): Promise<SessionInventoryRecord>;
  getTranscript(
    inventoryId: string,
    query: TranscriptQuery,
  ): Promise<TranscriptPage>;

  activateSession(
    inventoryId: string,
    request: ActivationRequest,
  ): Promise<ActivationTicket>;
  exportSession(
    sessionRef: string,
    request: SessionExportRequest,
  ): Promise<SessionExportTicket>;

  getManagedSession(sessionRef: string): Promise<SessionResource>;
  openSessionChannel(options: SessionChannelOptions): Promise<DashboardChannel>;
  openTuiChannel(options: TuiChannelOptions): Promise<DashboardTuiChannel>;
}
```

`DashboardChannel` supports:

- atomic initial state plus high-water cursor;
- `get_state`, `get_entries`, `get_session_stats`, `get_commands`, and available
  models;
- prompt, steer, follow-up, abort, model/thinking, queue, compaction, name,
  tree/fork/clone, and supported command operations;
- raw Pi lifecycle/message/tool/entry events;
- correlated extension UI requests/responses;
- controller request/release state;
- bounded replay and explicit replay gaps; and
- close without closing the underlying session.

Both backends run against a shared conformance suite. A feature is unavailable
in the SPA unless both backends either implement it or advertise an explicit
capability difference.

## 8. Session inventory and identity

### 8.1 Sources

The sidebar is a merge of:

1. **Managed catalog records** — resident/dormant daemon sessions, including
   memory sessions with no JSONL file.
2. **External Pi JSONL inventory** — files under configured session roots,
   initially the selected `agentDir` session directory and any explicit
   owner-approved `web.inventory.roots`.
3. **Ownership links** — persisted mappings between an external source,
   direct/co-opt lease or imported fork, managed conversation, and later exports.

The inventory never recursively scans arbitrary client-supplied paths.
Configured roots are canonicalized, owner checked, bounded, and may not escape
policy through symlinks.

### 8.2 Stable dashboard identity

A browser-facing `inventoryId` is an opaque server-generated identifier. For a
file it is derived from the canonical file identity/path and a format version;
it is not a raw filesystem path. Records also carry, where available:

- Pi session UUID;
- daemon session ID/name/generation/revision;
- source kind: `managed`, `external`, `direct`, `imported`, `exported`, or
  `memory`;
- canonical source file path, only in the authenticated information resource;
- source fingerprint: device/inode where portable, size, mtime, and bounded
  content/header digest;
- cwd, explicit session name, parent session, timestamps, counts, and current
  leaf; and
- activation eligibility and a safe reason when preview-only.

Duplicate Pi UUIDs at different paths are not silently collapsed. A canonical
source/ownership mapping selects the active item and the information view shows
all aliases/conflicts.

### 8.3 Title and ordering

Sidebar title precedence:

1. latest explicit Pi `session_info.name`;
2. daemon catalog name;
3. first `N` words of the first visible user message;
4. `Untitled session` plus a short safe ID.

The title is whitespace normalized, single-line, length bounded, and visually
ellipsized by CSS. Server search uses name, first-message text, cwd basename,
Pi ID, and daemon ID without returning full `allMessagesText` to the browser.

Default order is descending source modification time, then stable
`inventoryId`. Human ages (`3m`, `2h`, `4d`, and expanded “3 minutes ago” for
accessible labels/tooltips) are calculated from server timestamps and refreshed
client-side.

### 8.4 Fast index

A full `SessionManager.listAll()` scan is not on the request path. Dash keeps an
owner-private persisted index under:

```text
STATE_DIR/web/
  inventory-v1.json
  projections/
  ownership-v1.json
```

Startup loads this bounded index immediately, serves it with a freshness marker,
and reconciles the filesystem in the background. Filesystem notifications are
hints only; a bounded periodic reconcile repairs missed events. Atomic writes,
format versions, size/count limits, and corruption quarantine match existing
Pi Daemon durability rules.

The index stores only metadata and bounded search excerpts. It never stores
provider credentials, raw environment values, system prompts, or full tool
outputs.

## 9. Preview, activation, and hydration

Opening a session has three independent stages so visual speed is not held
hostage by SDK initialization.

### 9.1 Stage A — preview

`getTranscript()` reads a cached normalized projection keyed by source
fingerprint. On a miss, a bounded parser projects the Pi JSONL active branch and
populates the cache. It does not load extensions, initialize models, check
provider auth, or send a turn.

The default chat view renders the active leaf branch. The complete tree remains
available for a later tree navigator. Compaction and branch summaries are
visible records, not silently expanded into fabricated messages.

Cold parsing must not block the daemon event loop for an unbounded interval.
Large files are processed in bounded chunks or worker threads, with limits on
file bytes, line bytes, entries, image bytes, output bytes, and wall time. The
response may page older entries while returning the newest viewport first.

### 9.2 Stage B — activation and ownership

In parallel with preview, Dash resolves a managed session and an explicit file
ownership mode:

- **reuse** — use an existing catalog/ownership mapping;
- **direct/co-opt** — Pi Daemon opens the existing file and becomes its intended
  writer until release;
- **fork/import** — copy/import the active tree to a new UUID/file and leave the
  source untouched; or
- **preview-only** — show history but reject mutation with an actionable reason.

New Dash-created sessions use the configured session storage policy. The
recommended default is `pi-session-root`, so their unique files appear directly
in stock Pi's session picker. `daemon-owned` remains available for isolated
service instances. This requires replacing the current blanket agent-directory
rejection with a narrow capability for the canonical `sessions/` subdirectory;
credential/config siblings remain forbidden.

Every activation requires:

- regular owner-owned non-symlink source and canonical approved session root;
- valid bounded Pi session JSONL/header;
- cwd under the daemon's configured allowed roots;
- no known conflicting daemon owner/controller/mutation;
- explicit trusted runtime policy; and
- source fingerprint revalidation at the ownership/copy boundary.

Stock Pi currently provides no cooperative JSONL file lock, so “currently open
in a Pi CLI” detection is necessarily best effort until an upstream/adopted
lease convention exists. Dash combines:

- daemon catalog/controller/residency knowledge;
- an owner-private cooperative lease registry;
- optional platform open-file observation where available without making it a
  correctness dependency; and
- inode/size/mtime/prefix checks before every mutation boundary.

If a direct file changes outside the daemon after hydration, Dash stops writes,
marks `external_write_conflict`, preserves both histories, and offers to fork.
The direct-mode confirmation explains that an unmodified stock Pi process does
not honor the cooperative lease. “Trust me” remains available because the user
owns both processes, but it is never silent.

### 9.3 Export back to Pi

Any daemon-owned/imported conversation can be exported through a durable,
idempotent operation:

- **export-as-new** (default) writes a new timestamped Pi JSONL with a new Pi
  session UUID and parent/source metadata under the normal Pi session root;
- **append-back-to-origin** is allowed only when the original is an unchanged
  exact prefix/fingerprint, the managed delta forms a valid continuation, and
  no writer is known; and
- replacement/overwrite of a diverged original is forbidden. Dash exports a new
  sibling instead and shows the conflict.

The exported file is owner-private, atomically published, indexed immediately,
and available to stock Pi. Export never silently changes the daemon's active
writer; an explicit “export and release” option may close the runtime and hand
the exported file back to normal Pi use.

### 9.4 Stage C — hydrate and attach

After activation, Dash opens a framed observer or controller channel. This may
hydrate a dormant runtime. The initial state is reconciled with the preview
using Pi entry IDs, not array position or text equality.

Hydration never prompts. The pane becomes interactive only after:

- generation and host identity are current;
- the initial state/entries boundary is complete;
- runtime policy and provider readiness are known; and
- controller status is granted.

An observer still displays live output and may request control. It cannot send
mutating commands.

### 9.5 Warm residency

Visible panes hold bounded renewable residency leases. Idle eviction skips a
valid lease, but lease count and duration are bounded so a browser cannot pin
unlimited runtimes. Leases expire promptly after disconnect.

Defocused sessions stay resident until the configured warm TTL/LRU limit. The
browser keeps a bounded normalized transcript cache, so switching back remains
fast even if the server has evicted the SDK runtime. Rehydration is transparent
and still sends no prompt.

Provisional defaults:

- daemon idle TTL: existing 30 minutes;
- visible-pane lease heartbeat: 20 seconds;
- lease expiry: 60 seconds;
- maximum server-resident sessions: existing daemon limit;
- maximum pane-pinned sessions per workspace: 8;
- browser transcript cache: byte-bounded LRU, not an unbounded component tree.

## 10. Browser HTTP and WebSocket contract

Provisional same-origin routes:

| Method/path | Purpose |
| --- | --- |
| `GET /dash/` | SPA shell |
| `GET /dash/assets/*` | immutable content-hashed assets |
| `POST /dash/v1/login` | exchange web login credential for HttpOnly session |
| `POST /dash/v1/logout` | revoke browser session |
| `GET /dash/v1/bootstrap` | capabilities, effective safe settings, workspace summary |
| `GET /dash/v1/sessions` | filtered/sorted/paged merged inventory |
| `GET /dash/v1/sessions/{inventoryId}` | full safe metadata/info resource |
| `GET /dash/v1/sessions/{inventoryId}/transcript` | paged normalized transcript |
| `POST /dash/v1/sessions/{inventoryId}/activate` | idempotent reuse/direct/fork activation ticket |
| `GET /dash/v1/activation/{ticketId}` | activation state |
| `POST /dash/v1/sessions/{sessionRef}/export` | idempotent export-as-new/append-back/release ticket |
| `GET /dash/v1/workspaces/{workspaceId}` | persisted split tree and pane targets |
| `PUT /dash/v1/workspaces/{workspaceId}` | optimistic layout/pane update |
| `GET /dash/v1/settings` | defaults plus runtime overlay and revision |
| `PATCH /dash/v1/settings` | validated mutable runtime overlay |
| `DELETE /dash/v1/settings` | clear overlay/revert to configured defaults |
| `GET /dash/v1/stream` | browser WebSocket for subscriptions, commands, presence, settings/inventory deltas |

The browser WebSocket is not raw Pi RPC. It is a bounded dashboard protocol that
can multiplex several pane/session subscriptions over one connection while
preserving origin command IDs and daemon cursors. `DashboardSessionChannel`
translates to/from framed Pi RPC internally.

Every record carries protocol version, browser workspace/client ID, session
identity where relevant, and a correlation ID. Unknown minor fields are ignored.
Breaking changes require `/dash/v2`.

HTTP pages use opaque cursors and strong ETags. Commands are bounded,
correlated, and never blind-replayed after disconnect. A reconnect restores
subscriptions from retained cursors and reports explicit gaps.

## 11. Transcript and live event model

The frontend reducer has one normalized store per Pi conversation/generation.
It merges:

- persisted projected entries keyed by Pi entry ID;
- partial assistant content keyed by message/tool-call identity;
- tool execution start/update/end events;
- queue, compaction, retry, model, thinking, and session-name changes;
- `entry_appended` durable records; and
- host/generation/cursor transitions.

`entry_appended` replaces matching optimistic/live records. Duplicate replay is
idempotent. A replay gap triggers `get_entries`/transcript reconciliation; it
does not append a duplicate transcript.

The message renderer component inventory begins with:

- user text/images;
- assistant markdown, thinking, errors, usage, and streaming cursor;
- tool call/result shells with pending/success/error states;
- built-in specialized renderers for read, bash, edit/diff, write, grep, find,
  and list;
- generic custom tool renderer with expandable args/content/details;
- bash execution messages;
- compaction and branch-summary cards;
- custom messages, hidden custom messages, and custom entry fallback cards;
- labels/model/thinking/session-info timeline markers; and
- queue/retry/compaction/permission/extension UI state.

Markdown is rendered with raw HTML disabled or sanitized. Links use safe schemes
and external-link protections. Code and large output are virtualized/collapsed;
syntax highlighting is lazy and bounded.

## 12. Session liveness and attention model

Liveness is represented by orthogonal server facts:

```ts
interface DashSessionPresence {
  runtime: "unmanaged" | "dormant" | "resident-idle" | "running" | "failed";
  activation:
    | "untouched"
    | "selected"
    | "user-turn"
    | "external-turn"
    | "scheduled-turn"
    | "running-at-dash-start";
  scheduled?: { nextWakeAt: string; source: string };
  focusedPaneCount: number;
  lastSettledCursor?: string;
  seenCursor?: string;
  unread: boolean;
}
```

`runtime` is daemon truth. `activation` is dashboard-process provenance and does
not pretend that an idle green session is consuming compute. Selection and
non-scheduled turns make a session green for the current Dash process lifetime,
even if its SDK runtime is later evicted; a Dash restart reconstructs green only
for a runtime that was running at startup. A schedule-triggered turn does not
convert the dormant base color to green.

Visual priority and semantics:

| State | Indicator |
| --- | --- |
| running now | glowing blue dot |
| failed/degraded | error-colored dot plus accessible text; never disguised as dormant |
| scheduled but not running, regardless of selection/residency | dark-magenta dot plus `10m`, `1h`, etc. countdown |
| selected, previously user/external activated, successfully settled, or running at Dash startup | green dot |
| untouched unmanaged/dormant session | grey dot |
| completed since this workspace last saw it | independent white ring and white center dot around the underlying state color |

Thus a scheduled unseen completion is dark magenta **plus** the white attention
ring, while a user-started unseen completion is green plus the same ring.
Unread is acknowledged only when a pane for that session is visible/focused and
has consumed through the settlement cursor. Merely listing the session does not
acknowledge it.

Seen cursors are persisted per dashboard workspace on the server. Local storage
may cache them for immediate paint but is not authoritative. Multiple browser
workspaces therefore have independent unread state.

### 12.1 Scheduled wakes

Pi Daemon now has a neutral native wake scheduler. Timer display remains
capability-gated so older or store-only hosts do not fabricate state. The
persisted schedule resource includes:

- schedule ID, enabled state, IANA timezone, and validated cron expression;
- bounded prompt and optional model/thinking override;
- next/last scheduled time and safe terminal ticket summary;
- overlap policy (`skip`, `queue-one`, or reject; never concurrent same-session
  turns);
- missed-wake policy after downtime (`skip`, `run-once`, or bounded catch-up);
- jitter and maximum run/admission delay;
- normal durable prompt idempotency/ticket semantics; and
- audit-safe creation/update/delete metadata without prompt content in logs.

The scheduler submits through the same durable wake/prompt admission path as any
other client. A crash after acceptance remains indeterminate and is never
blindly replayed. Existing external timers remain supported clients; native
schedules are additive. Dash exposes CRUD in the session information/settings
UI and receives authoritative `nextWakeAt` for the magenta countdown.

Hosts that omit the capability retain absent scheduled indicators rather than
fabricating them. Cacophony-specific heartbeat state remains out of this
repository.

## 13. SPA information architecture

### 13.1 App shell

- full viewport application;
- left session sidebar;
- right split-pane workspace;
- command palette and settings modal overlays;
- responsive collapse to a session drawer on narrow screens;
- accessible focus order, ARIA labels/live regions, keyboard alternatives, and
  reduced-motion support.

### 13.2 Sidebar

The sidebar includes:

- heading and aggregate counts;
- fuzzy/server-backed search;
- expandable filters/groups (all, running, unread, scheduled, named, project,
  managed/external, recent age bands);
- virtualized, recently-updated session list;
- per-item liveness/attention indicator;
- title and relative modified time;
- optional cwd/project secondary line;
- info icon with hover/focus popover; and
- bottom settings button.

Hovering/focusing the info icon shows bounded metadata. Clicking it puts a full
information view in the selected workspace pane. Clicking the rest of the row
puts the chat view there.

### 13.3 Chat pane

A chat pane contains:

- title, liveness/controller state, pane actions, and a per-pane **Rich / TUI**
  presentation toggle;
- virtualized transcript with “jump to latest” behavior;
- streaming assistant/tool updates as soon as emitted by Pi Daemon;
- queued steering/follow-up messages;
- extension UI dialogs/widgets/status where serializable;
- composer with multiline editing, paste/images, submit/steer/follow-up, abort,
  history, and explicit busy/controller states; and
- semantic chips below the composer for cwd, context usage/window, token/usage
  summary, provider/model, thinking effort, tool policy, and generation.

The context chip uses SDK `getContextUsage()`/session stats when hydrated. A
preview-only session labels estimates as such rather than inventing an exact
percentage.

### 13.4 Commands and completion

Autocomplete combines:

- a browser-owned registry mapping supported built-in commands to typed RPC
  operations (`/model`, `/thinking`, `/compact`, `/name`, `/new`, `/tree`,
  `/fork`, `/clone`, `/abort`, and related controls);
- `get_commands` output for extension commands, prompts, and skills; and
- future server-side completion providers when Pi exposes a serializable seam.

Pi's `get_commands` does not include built-in interactive commands or extension
argument-completion callbacks. V1 must document this ceiling. Sending `/settings`
or another TUI-only built-in as an ordinary prompt is forbidden; Dash handles
its own settings UI.

### 13.5 Vim input

The composer supports normal multiline mode and an optional real modal Vim
mode. This is a browser editor concern, not an attempt to execute Pi's terminal
`CustomEditor`. A CodeMirror 6 editor with a maintained Vim keymap is the
provisional choice. It must preserve IME, accessibility, paste, autocomplete,
and app shortcuts.

`Ctrl-h/j/k/l` pane navigation applies outside composer insert mode.
`Ctrl-Shift-h/j/k/l` swaps the focused pane with its spatial neighbor in that
direction while retaining focus on the moved pane. Conflict resolution and a
discoverable keyboard-help overlay are required.

### 13.6 Information pane

The information view includes, when available:

- inventory ID/source type/Pi UUID/daemon ID/name;
- JSONL path, file size, mtime, creation time, parent source, and fingerprint;
- cwd and activation-policy eligibility;
- direct/import/export ownership and source relationships;
- daemon generation/revision/residency/state and last terminal outcome;
- current leaf, branches, entry/message/tool counts;
- provider/model/thinking/context/usage/cost;
- tools/resources/trust/isolation summaries without secret values;
- controller/readers and warm lease state;
- next scheduled wake when supported; and
- safe diagnostics and extension/resource load errors.

## 14. Split-pane workspace

Workspace layout is a persisted binary tree:

```ts
type LayoutNode =
  | { type: "leaf"; paneId: string; content?: PaneTarget }
  | {
      type: "split";
      direction: "horizontal" | "vertical";
      ratio: number;
      first: LayoutNode;
      second: LayoutNode;
    };
```

Rules:

- startup has one selected empty leaf unless the workspace restores safely;
- sidebar Agent/Info selection populates the selected leaf;
- splitting a populated leaf keeps its content in the left/top child and creates
  an empty right/bottom child;
- panes are resizable by mouse-dragged split handles, with keyboard alternatives
  and bounded minimum dimensions;
- mouse click selects/focuses a pane;
- `Ctrl-h/j/k/l` chooses the spatially nearest pane in that direction;
- `Ctrl-Shift-h/j/k/l` swaps the selected leaf with the spatial neighbor in that
  direction and retains focus on the moved pane;
- closing a pane promotes its sibling;
- multiple panes may reference one session; they share one normalized
  transcript and one server session channel rather than opening duplicate
  controller attachments;
- chat and information panes for the same session may coexist; and
- workspace changes are optimistically updated with revision/ETag checks and
  atomically persisted under `STATE_DIR/web/workspaces/<id>.json`.

Local storage keeps only a generated opaque workspace ID and optional fast paint
cache. The server copy is authoritative and supports restore after browser cache
loss.

## 15. Extension UI and dual renderer compatibility

### 15.1 Rich-web mode

Rich mode supports natively:

- `select`, `confirm`, `input`, and editor requests as browser modals;
- request timeout/cancellation and controller-only responses;
- notifications/toasts;
- string-array status and widgets above/below the composer;
- title/editor-text updates;
- custom messages and custom entries through safe generic renderers;
- tool args/results/details through generic renderers; and
- browser-native built-in tool, diff, markdown, code, and image renderers.

Executable terminal `renderCall`, `renderResult`, message-renderer, and
entry-renderer functions are not sent to the browser. Rich mode shows a visible
safe generic fallback rather than blank space.

### 15.2 TUI-embed mode

A TUI pane renders a server-side virtual terminal:

1. the browser measures its configured monospace cell and pane content box;
2. `ResizeObserver` derives bounded rows/columns and sends coalesced resize
   records;
3. daemon `VirtualTerminal` implements Pi TUI's `Terminal` interface;
4. Pi TUI renders messages, tools, custom renderers, widgets, overlays, editor,
   footer, and extension components into ANSI terminal output;
5. a headless terminal emulator converts output to a bounded canonical grid of
   styled row segments, cursor, title, and safe image placeholders;
6. the browser renders changed row segments as a monospaced virtualized
   `TuiGrid` of styled DOM runs with an accessible text representation (a canvas
   fast path is optional only if it preserves that mirror); and
7. controller keyboard/paste/resize input is translated back to terminal input.

Dangerous terminal side channels are stripped or modeled explicitly: OSC 52
clipboard, arbitrary file/URL launch, unsupported device queries, sixel/Kitty
payload bytes, title escape abuse, and unbounded control sequences never reach
browser APIs directly.

The daemon owns one canonical interactive shadow view per session. Multiple TUI
panes mirror it; the focused controller pane supplies canonical dimensions and
input, while observers cannot race separate extension UI instances. Focus
changes may resize/reflow the view but do not recreate the agent runtime.

### 15.3 Required Pi seam and no-PTY rule

Pi TUI itself is injectable, but current `InteractiveMode` hardcodes
`ProcessTerminal`, process signals, and one extension UI binding. Before full
TUI mode, the project must either land upstream or pin and test a supported seam
such as:

```ts
new InteractiveSessionView(runtime, {
  terminal: VirtualTerminal,
  processOwnership: "external",
  uiBroker,
});
```

The seam must separate view lifetime from process lifetime, rebind after
session replacement, preserve one extension instance, and coexist with RPC
observers. Pi Daemon must not monkey-patch private fields.

Spawning `pi --session ...` in a shadow PTY is not the normal implementation: it
would add a process per view, duplicate extension/runtime state, and risk a
second JSONL writer. A separately supervised compatibility PTY may be explored
only as an explicit degraded fallback, never as the architecture or silent
behavior.

A read-only TUI mirror can land earlier using Pi's exported message/tool
components and registered renderers. Full `ctx.ui.custom()`, component widgets,
overlays, custom editor, and terminal interaction are accepted only after the
injected interactive-view conformance suite passes.

### 15.4 Future declarative web extension contract

A later complementary design may let trusted extensions register versioned
declarative view models from a strict allowlist: text, markdown, code, diff,
image, key/value table, status, stack/grid, actions, and forms. The server
validates and bounds the view tree; the SPA owns rich rendering. No extension
code is downloaded to or evaluated by the browser by default.

This contract must be useful in TUI/RPC/web modes or clearly capability-scoped.
It should preferably be proposed upstream to Pi rather than maintained as an
incompatible hidden renderer ecosystem.

## 16. Configuration and runtime settings

### 16.1 Configuration layers

Service/security configuration and mutable UI preferences are separate.

1. compiled defaults;
2. owner configuration YAML at
   `~/.config/pi/daemon/<instance>/config.yaml`;
3. CLI flags for service startup;
4. Home Manager-generated file/selection/startup options;
5. persisted **UI-only** runtime overlay.

`--config PATH` has highest config-file-selection priority, followed by
`PI_DAEMON_CONFIG`, then the instance-derived default path. Individual CLI
options override YAML fields. The runtime overlay may change only an
allowlisted UI schema (theme, editor, sidebar, panes, rendering, cache display
preferences). It may **not** change bind addresses, ports, TLS policy, auth,
inventory roots, allowed workload roots, credential paths, or daemon resource
limits.

The instance name comes from `--instance`, then `PI_DAEMON_INSTANCE`, then
`default`; it is validated as the same bounded service identifier used by Home
Manager. Secrets remain file/fd/environment references and never literal YAML
values. Durable runtime state remains under `stateDir`—configuration and mutable
state are deliberately not conflated merely because both are owned by Dash.

### 16.2 Example YAML

```yaml
instance: default
stateDir: ~/.local/state/pi-daemon/default
socketPath: ~/.local/state/pi-daemon/default/run/pi-daemon.sock
allowedRoots:
  - ~/work
sessionStorage:
  mode: pi-session-root

web:
  enabled: true
  mode: embedded
  bind: 127.0.0.1
  port: 7464
  auth:
    tokenFile: ~/.config/pi-daemon/web-token
    sessionTtlMs: 43200000
  inventory:
    roots: []
    reconcileIntervalMs: 30000
    maxSessions: 10000
  residency:
    warmTtlMs: 1800000
    maxPinnedPerWorkspace: 8
  tui:
    enabled: true
    defaultPresentation: rich
    maxRows: 200
    maxColumns: 320
  ui:
    editor:
      mode: vim
    sidebar:
      initialLimit: 100
    theme:
      name: nord-midnight
```

`web.mode: dedicated` is consumed by `pi-daemon web`, not used to spawn a
second process from `serve`. Lifecycle remains supervisor-owned. Existing CLI
flags remain supported for automation and compatibility; adding YAML does not
force every caller to generate a file.

### 16.3 Home Manager

Each `services.pi-daemon.instances.<name>` gains typed `web` options:

- `enable`;
- `mode`/embedded enablement;
- `bind`, `port`, and remote plaintext/TLS-proxy policy;
- `tokenFile`;
- inventory roots and bounded reconcile limits;
- residency limits;
- immutable UI defaults/theme; and
- dedicated service declaration when selected.

Assertions cover port uniqueness, token-file uniqueness, valid port arithmetic,
owner-safe roots, protected extra args, and dedicated mode requiring the daemon
API endpoint/token.

### 16.4 Settings modal

The bottom-sidebar settings button opens a rich modal. It shows effective values
and their source (`default`, YAML/Nix, or runtime override). Initial mutable
categories:

- theme and density;
- font/markdown/code/tool display;
- editor mode and Vim preferences;
- sidebar grouping/search/age display;
- split behavior and keyboard hints;
- transcript expansion/virtualization preferences;
- notifications and reduced motion; and
- safe browser cache limits.

Changes are validated server-side and atomically written to
`STATE_DIR/web/runtime-settings.json` with revision checks. “Revert to defaults”
deletes the runtime overlay and immediately reapplies configured defaults.

## 17. Semantic theming

No component owns literal presentation colors. Themes are validated data that
resolve to CSS custom properties. Component values inherit from semantic core
tokens and may be overridden narrowly.

Provisional schema shape:

```yaml
web:
  ui:
    theme:
      name: nord-midnight
      color:
        bg: { canvas: "#0f141f", surface: "#151b2b", elevated: "#1d2638" }
        fg: { primary: "#eceff4", muted: "#aeb8c8", dim: "#788397" }
        accent: { primary: "#88c0d0", secondary: "#81a1c1" }
        state:
          success: "#a3be8c"
          running: "#88c0d0"
          scheduled: "#b48ead"
          warning: "#ebcb8b"
          error: "#bf616a"
      border: { color: muted, width: 1px, style: solid, radius: 10px }
      message:
        user: { color: { bg: surface, fg: primary }, border: { color: accent } }
        assistant: { color: { bg: canvas, fg: primary } }
        system: { color: { bg: elevated, fg: muted } }
        thinking: { color: { bg: surface, fg: dim } }
      tool:
        pending: { color: { bg: surface, fg: primary } }
        success: { color: { bg: surface, fg: primary } }
        error: { color: { bg: surface, fg: primary } }
      sidebar:
        color: { bg: surface, fg: primary }
        selected: { color: { bg: elevated, fg: primary } }
      pane:
        focused: { border: { color: accent } }
```

The actual default Nord Midnight values live in one theme definition, not spread
through CSS. Values such as border style/width/radius, spacing, shadow, and
motion come from bounded enums/ranges to prevent arbitrary CSS injection.

Themes support hot switching, light/dark metadata, contrast tests, reduced
motion, and component preview in Settings. Browser themes are distinct from Pi
terminal themes but may include an explicit importer/mapping for common Pi
semantic tokens.

## 18. Browser authentication and security

### 18.1 Credentials

- Daemon service bearer remains server-to-server only.
- Embedded Dash uses the daemon's authenticator internally but exposes a
  separately scoped web login/session mechanism.
- Dedicated Dash loads the daemon bearer privately and has its own web login
  secret.
- Login exchanges a web token for a short-lived, revocable, signed opaque
  `HttpOnly; Secure` (when TLS); `SameSite=Strict` cookie.
- Tokens are never placed in URLs, static HTML, JavaScript bundles,
  `localStorage`, workspace records, logs, or error payloads.

Loopback is not treated as authentication: malicious websites can target local
servers. Every state-reading route, asset bootstrap with private data, and
WebSocket requires an authenticated browser session.

### 18.2 Browser controls

- exact `Origin`/Host validation on mutations and WebSocket upgrades;
- CSRF tokens or same-origin custom headers in addition to SameSite cookies;
- strict CSP with no CDN, inline script, eval, or arbitrary extension script;
- `frame-ancestors 'none'`, no MIME sniffing, restrictive referrer policy;
- content-hashed same-origin assets;
- sanitized markdown and safe link/image schemes;
- bounded decompression/JSON/WS/frame/body/header/output sizes;
- connection, channel, subscription, command, workspace, and settings limits;
- no prompt/model output in logs by default;
- canonical owner-only file checks for inventory and persistent web state; and
- non-loopback service requires HTTPS or the same explicit insecure-development
  override discipline as the daemon API.

### 18.3 Session authority

Preview access does not grant runtime cwd/tool authority. Activation separately
checks allowed roots and trusted default session policy. The SPA clearly marks
preview-only sessions and never offers a send button that will inevitably fail
or bypass policy.

## 19. Performance and resource budgets

Initial local targets, measured with 10,000 indexed sessions and representative
large transcripts:

- persisted-index bootstrap response: p95 under 50 ms;
- first sidebar rows painted from network/cache: p95 under 150 ms;
- server search/filter page: p95 under 100 ms after index load;
- cached transcript newest viewport: p95 under 150 ms;
- cold normal transcript useful viewport: p95 under 500 ms;
- live Pi delta to browser reducer: p95 under 50 ms excluding rendering frame;
- shadow-TUI row delta after Pi TUI render: p95 under 50 ms;
- one animation/render frame under 16 ms for normal streaming updates;
- no O(total sessions) synchronous work on an HTTP request;
- no O(total transcript entries) DOM tree; lists/transcripts are virtualized;
- production SPA initial gzip budget provisionally 1.5 MiB, with lazy chunks for
  syntax highlighting, settings, tree view, and Vim support.

Every cache has count, byte, age, and single-record limits. Projection cache
entries are invalidated by source fingerprint. Browser IndexedDB may cache
immutable projections and assets; localStorage is reserved for tiny opaque IDs
and non-authoritative hints.

Large images/tool output are represented by bounded previews and fetched lazily
through authorized blob routes if retained data permits. The browser never
decodes an unbounded base64 field merely because it exists in JSONL.

## 20. Frontend stack (provisional)

Recommended starting stack:

- TypeScript;
- React and Vite for a static, content-hashed SPA;
- CodeMirror 6 plus maintained Vim bindings for the composer;
- a mature virtual-list primitive for sidebar/transcript;
- a small normalized state/event reducer rather than duplicating server models;
- CSS custom properties generated from the semantic theme schema;
- browser-native split-tree implementation or a small audited resizer library;
- sanitized CommonMark/GFM renderer with lazy syntax highlighting;
- an audited headless ANSI/terminal-grid implementation for daemon shadow-TUI
  projection, with a browser styled-run grid or xterm-compatible renderer; and
- Playwright for browser acceptance and visual regression.

Dependencies must be exact-pinned in `package-lock.json`, work under Node
>=22.19, add no runtime CDN, and receive license/security review. A smaller
framework is acceptable if a spike proves it can meet editor, virtualization,
a11y, and high-fidelity requirements without recreating those systems badly.

## 21. Packaging and lifecycle

- `npm run build` builds server TypeScript and the SPA.
- Static output is copied under `dist/web` and included in `npm pack` and the Nix
  package.
- Assets are served from an explicit manifest; production never invokes Vite or
  npm dynamically.
- The package remains one distributable Pi Daemon artifact even though it
  contains two executable modes.
- `pi-daemon serve` owns embedded Dash start/drain/stop under the daemon's whole
  shutdown deadline.
- `pi-daemon web` owns only its browser server/backend connections and exits
  nonzero when it cannot authenticate or negotiate a compatible daemon.
- Dedicated Home Manager mode creates a separate supervised service ordered
  after the daemon API.
- Health distinguishes static server readiness, inventory freshness, daemon
  backend readiness, browser auth readiness, and degraded projection/index
  state.

## 22. Observability

Safe metrics/status include:

- web server connections/auth failures;
- active browser workspaces and session channels;
- inventory entries, reconcile duration, stale age, and failures;
- projection hits/misses/build latency/bytes/evictions;
- preview-to-first-byte and activation/hydration latency;
- resident leases and rejected pin capacity;
- RPC reconnects/replay gaps/controller conflicts;
- outbound queue/slow-client disconnects;
- SPA asset/build version; and
- settings/workspace persistence health.

Logs include request IDs, opaque inventory/session IDs, operation, duration,
status class, and safe error code. They omit paths by default and always omit
session content, prompts, model output, tool output, tokens, cookies, auth, raw
environment, and credentials.

## 23. Testing strategy

### 23.1 Core unit tests

- version 1/2/3 JSONL inventory and projection;
- branches, current leaf, compaction, labels, names, custom records, images, and
  malformed/orphaned entries;
- title derivation, search normalization, ordering, opaque cursors;
- index recovery, stale fingerprints, atomic writes, corruption, symlinks,
  ownership, and bounds;
- direct/fork/export idempotency, source revalidation, cwd/root policy, duplicate UUIDs,
  and managed mapping;
- liveness/attention precedence and seen-cursor transitions;
- layout tree split/close/focus/spatial navigation, mouse resize, and
  Ctrl-Shift-h/j/k/l focus-preserving swaps;
- settings precedence, mutable allowlist, revision, and reset;
- theme inheritance/validation/contrast; and
- transcript live/persisted deduplication and replay-gap reconciliation.

### 23.2 Backend conformance

Run the same scenarios against `InProcessDashboardBackend` and
`RemoteDashboardBackend`:

- list/info/preview;
- activation and failed activation;
- dormant hydration without a prompt;
- snapshot and entry retrieval;
- observer/controller behavior;
- prompt streaming through tool calls to `agent_settled`;
- steering/follow-up/abort;
- model/thinking/command changes;
- extension dialogs/widgets/notifications;
- rich/TUI presentation switching, virtual resize/input, custom terminal
  renderers, and dedicated-mode TUI frame parity;
- disconnect/reconnect/replay/gap;
- idle eviction and rehydration; and
- generation replacement.

### 23.3 HTTP/security

- unauthenticated routes and upgrades reveal no session existence;
- login/session expiry/revocation;
- cookie, Origin, Host, CSRF, TLS/plaintext policy;
- traversal/symlink/owner/mode checks;
- CSP and static asset headers;
- markdown/XSS/link/image sanitization;
- body/header/frame/output/connection/rate limits;
- no bearer or content in logs/errors/workspace/settings files; and
- dedicated backend never forwards browser credentials as daemon credentials.

### 23.4 Browser acceptance

Playwright scenarios cover:

- fast sidebar/search/filter;
- preview then hydration with no accidental prompt;
- live text/thinking/tool streaming;
- command completion and rich chips;
- Vim insert/normal mode and IME-safe text input;
- split/resize/close/mouse and Ctrl-h/j/k/l navigation;
- info popover/pane;
- liveness dots, countdowns, unread ring, and acknowledgement;
- mouse split resize and focus-preserving Ctrl-Shift-h/j/k/l pane swaps;
- Rich/TUI pane toggle, terminal-grid resize/input, custom component rendering,
  and accessible text mirror;
- controller conflict/read-only state;
- settings persistence/reset and theme switching;
- reconnect/replay gap;
- narrow/mobile layout;
- keyboard-only and screen-reader basics; and
- deterministic high-fidelity visual snapshots for Nord Midnight.

### 23.5 Performance/soak

- 10,000-session inventory and repeated reconcile;
- multi-gigabyte aggregate inventory with per-file bounds;
- very large/branch-heavy session projection;
- long-running streamed turn with rapid tool updates;
- many panes sharing and not duplicating channels;
- slow/disconnected browsers;
- projection/browser/server LRU pressure;
- idle lease expiry and runtime eviction;
- repeated TUI pane resize/focus/mirror churn without duplicate runtimes or
  extension instances; and
- 24-hour embedded and dedicated soak without unbounded heap growth.

## 24. Delivery plan and dependency board

The project board is authoritative. Every item below is a real bead with daemon
validated dependencies; closing one wave automatically exposes its next ready
work. No slice may weaken Pi Daemon's current security, durability, RPC, ACP,
package, or performance gates.

Parent epic: `bd-ba3623`. Final v1 gate: `bd-7de9ec`.

### Ready foundation wave

These lanes intentionally begin in parallel:

- [x] `bd-933f1e` — browser/backend protocol, normalized transcript types,
  fixtures, capabilities, limits, and measurable performance budgets.
- [x] `bd-493121` — production-representative beautiful 60fps SPA/Nord Midnight
  stack, editor, virtualization, split and accessibility spike.
- [x] `bd-e25765` — instance YAML convention, safe precedence, current CLI
  mapping, and Home Manager configuration foundation.
- [x] `bd-2756e4` — VirtualTerminal/headless-grid performance spike and supported
  Pi `InteractiveSessionView`/UI-broker seam proposal.

### Core data and browser shell

- [x] `bd-93e857` — persisted 10k-session inventory and instant search/order;
  depends on `bd-933f1e`.
- [x] `bd-3a8261` — bounded active-branch JSONL transcript projector/cache;
  depends on `bd-933f1e`.
- [x] `bd-50d480` — browser auth/static server/workspace/settings persistence;
  depends on `bd-933f1e`, `bd-e25765`.
- [x] `bd-cc87cb` — production SPA shell/sidebar/info/theme foundation; depends
  on `bd-933f1e`, `bd-493121`.
- [x] `bd-fd9f22` — direct co-opt/fork/import/conflict/export session ownership;
  depends on `bd-93e857`, `bd-3a8261`, `bd-e25765`.

### Dual backends and neutral API

- [x] `bd-246c6e` — neutral authenticated inventory/transcript/ownership/export/
  TUI API; depends on contract, inventory, projector, and ownership.
- [x] `bd-e1e692` — embedded backend over direct shared services; depends on
  contract, inventory, projector, and ownership.
- [x] `bd-ad4630` — dedicated REST/framed-RPC backend and reconnect parity;
  depends on `bd-933f1e`, `bd-246c6e`.

### Rich UI, workspace, and shadow TUI

- [x] `bd-c0df45` — beautiful virtualized rich transcript and built-in/custom
  tool rendering; depends on contract, frontend spike, and projector.
- [x] `bd-5f9ca1` — persistent mouse-resizable splits, focus/swaps, settings and
  Vim composer; depends on SPA shell and browser server.
- [x] `bd-da9e31` — one injected daemon shadow-TUI runtime/grid channel; depends
  on TUI spike, contract, embedded backend, and neutral API.
- [x] `bd-0b804d` — responsive interactive browser TUI grid and Rich/TUI toggle;
  depends on TUI/frontend spikes, contract, and SPA shell.
- [x] `bd-ea2019` — same-origin login/REST/WS client, server-backed inventory,
  preview-first hydration, correlated RPC/command flows, reconnect/replay,
  persisted seen cursors, liveness, export, and extension dialogs/widgets/status;
  depends on SPA shell, rich transcript, browser server, and both backends.
- [x] `bd-b9d8e6` — operator-directed embedded `serve` browser lifecycle slice;
  starts the packaged SPA/BFF now without waiting for the dedicated backend.
- [x] `bd-3a61f7` — authenticated bounded browser stream router from the BFF to
  Rich/TUI `DashboardBackend` channels with exact replay/control semantics.
- [x] `bd-31ee8f` — dedicated lifecycle, final dual-mode packaging, CLI, npm/Nix
  and Home Manager closure; depends on config/server/backends/SPA and the
  embedded lifecycle slice.

### V1 closure

- [ ] `bd-1dc765` — P1 production interactivity hotfix: constrain the lone
  workspace leaf so transcript scrolling and the composer remain interactive,
  use zero-minimum split tracks with resize-driven virtualization measurement,
  and replace decorative Settings navigation with revisioned accessible tabs.
- [ ] `bd-7de9ec` — visual, performance, security, dual-mode, soak and release
  acceptance; depends on live UI, workspace, TUI core/grid, and lifecycle.
- [ ] `bd-ba3623` — parent Dash epic; depends only on `bd-7de9ec` so it closes
  after the complete product gate.

### Follow-on scheduler epic

- [x] `bd-6d96bb` — schedule resource/schema contract; unblocked as a
  transport-neutral parallel slice.
- [x] `bd-cb3036` — durable timer runtime; depends on `bd-6d96bb`.
- [x] `bd-72aac0` — schedule HTTP/CLI/config; depends on contract and config.
- [x] `bd-edbc79` — beautiful Dash schedule editor/countdown/history; depends on
  schedule contract and live Dash.
- [x] `bd-aa4260` — timezone/DST/restart/overlap/security/soak acceptance; depends
  on runtime, API, and Dash schedule UX.
- [ ] `bd-4e10da` — scheduler parent epic; depends on `bd-aa4260`.

### Lazy new-session follow-on

- [x] `bd-e9fce1` — parent browser new-session flow: no runtime/model/tool work
  before the first explicit message and exactly one materialized first turn.
- [x] `bd-6a4170` — browser-safe draft contract, owner-private atomic draft/send
  ticket store, authenticated service/BFF CRUD, schema, fixtures, and docs.
- [x] `bd-96c3e1` — exact-once embedded/remote first-send materializer consuming
  deterministic private store checkpoints.
- [x] `bd-72d6fd` — sidebar/form/empty-pane UX reusing `bd-930d31`'s
  preview-composer first-send state machine.

### Other post-v1 work

- [ ] `bd-470f81` — declarative cross-mode rich extension renderer contract.
- [ ] `bd-4b2415` — full browser tree navigation/fork/clone experience.
- [ ] `bd-b31a5d` — multi-user identity and per-session authorization epic.
- [ ] `bd-e89a17` — optional native TLS and hardened remote browser deployment.

All four are dependency-blocked on `bd-7de9ec`. Root `PLAN.md` contains only a
concise epic cross-reference; this file remains the detailed Dash architecture.

## 25. V1 acceptance

Dash v1 is complete only when all of the following are true:

1. One npm/Nix artifact contains Pi Daemon, `pi-daemon web`, and the production
   SPA with no runtime npm/Vite/CDN dependency.
2. Embedded and dedicated modes pass the same backend conformance suite and show
   the same browser behavior.
3. A fresh authenticated browser sees the persisted sidebar quickly while a
   background scan is still reconciling.
4. Clicking an external Pi session paints a correct active-branch transcript
   before SDK hydration and never submits a model request.
5. New sessions can live in the normal Pi session root; existing external
   sessions support explicit direct/co-opt or fork/import ownership with
   conflicts detected, and managed sessions export safely back to stock Pi.
6. Sending a message streams assistant/tool state, survives reconnect within
   retention, reaches `agent_settled`, and returns to resident-idle.
7. Focused panes retain bounded warm leases; defocused sessions evict and later
   rehydrate without losing conversation identity.
8. Session title/age/info/search/order and liveness/unread indicators follow this
   document exactly.
9. Split layouts, mouse resize, keyboard/mouse focus, focus-preserving
   Ctrl-Shift-h/j/k/l swaps, info/chat pane selection, workspace persistence,
   settings reset, Vim input, and Nord Midnight theming pass browser acceptance.
10. Rich extension UI has safe fallbacks, while TUI panes render and interact
    through one injected in-process shadow view without a child Pi process,
    duplicate extension instance, or second session writer.
11. Service bearers never reach browser storage or output, all private routes
    authenticate, and security/bounds/log-redaction gates remain green.
12. Existing `npm test`, clean `npm pack`, Nix package/module checks, CRUD/RPC/ACP
    compatibility, and Nix-on-Droid cache-build contract remain green.

## 26. Recorded decisions and remaining confirmations

### 26.1 Recorded from design review

1. **Panel controls** — mouse resize is required; `Ctrl-h/j/k/l` navigates and
   `Ctrl-Shift-h/j/k/l` swaps with the directional neighbor while retaining
   focus.
2. **Configuration** — retain current CLI/Home Manager compatibility and add
   instance YAML at `~/.config/pi/daemon/<instance>/config.yaml`, selected by
   CLI/env convention. Runtime UI overrides remain state, not service config.
3. **Session files** — permit the canonical Pi session root as a narrow session
   data capability and recommended storage for new Dash sessions. Existing files
   offer explicit direct/co-opt or fork/import, with warnings, leases, conflict
   detection, and export back to stock Pi.
4. **Schedules** — keep v1 countdown capability-gated, but track a full neutral
   per-session cron/prompt scheduler as `bd-4e10da`, configurable through core
   APIs and Dash.
5. **Rendering** — every pane may toggle Rich or TUI presentation. TUI mode uses
   an injected in-process virtual terminal/shadow view rather than spawning a
   second Pi process. A declarative rich renderer remains complementary future
   work.

### 26.2 Still to confirm after Phase 0 spikes

1. **Default enablement** — embedded, authenticated, loopback Dash on port 7464
   by default (**requested/recommended after auth is complete**) versus opt-in
   until first release.
2. **Frontend stack** — React/Vite/CodeMirror/virtualization
   (**recommended**) versus a smaller custom-elements stack, decided from the
   bundle/render/accessibility spike.
3. **TUI seam delivery** — upstream the injectable `InteractiveSessionView`
   first (**preferred**) versus carrying a small pinned Pi patch while upstream
   review proceeds. Private-field monkey-patching and silent process PTYs are
   not options.
