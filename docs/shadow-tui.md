# Shadow TUI and virtual terminal

Pi Daemon can present Pi's terminal UI in a browser without starting a second
`pi` process. The reusable foundation is `VirtualTerminal`, exported from
`@harryaskham/pi-daemon/virtual-terminal`.

This document records the result of the Pi 0.80.6 shadow-TUI spike. It is an
implementation and upstream-integration contract, not a claim that the current
Dashboard lifecycle already exposes a TUI WebSocket. That lifecycle is a later
Dash milestone.

## Proven rendering path

`VirtualTerminal` implements the public `Terminal` interface from the exact
pinned `@earendil-works/pi-tui` package. A normal in-process `TUI` writes its
ANSI differential stream to this terminal. The terminal:

- has mutable, bounded rows and columns;
- accepts input and resize callbacks without reading stdin;
- projects ANSI output into a bounded Unicode cell grid;
- retains SGR foreground/background colors, emphasis and safe HTTP(S)/mailto
  OSC 8 hyperlinks;
- emits full frames followed by styled row deltas, cursor position, title and
  progress state;
- coalesces all writes since the prior frame, so transient intermediate ANSI
  operations are not sent to a browser;
- handles wide graphemes, combining marks, scrolling, erasure and the cursor
  operations emitted by Pi's differential renderer; and
- never starts a process, opens a PTY, writes stdout or touches a Pi session
  file.

The acceptance fixture renders Pi's exported `UserMessageComponent`,
`AssistantMessageComponent`, `ToolExecutionComponent` and
`CustomMessageComponent`, plus an overlay and focused extension-style editor,
through one `TUI` and one `VirtualTerminal`. Input travels back through the same
TUI focus path. Rapid representative deltas and resizes are measured against
Dashboard's `frameWorkP95Ms < 16` and `tuiDeltaP95Ms < 50` contracts.

### Resource limits

Defaults are hard ceilings, not suggestions:

| Resource | Default maximum |
|---|---:|
| columns | 320 |
| rows | 200 |
| one terminal write | 1 MiB |
| one escape/control sequence | 64 KiB |
| one input event | 16 KiB |
| title | 512 UTF-8 bytes |
| serialized frame | 512 KiB |

A caller may lower these limits but cannot raise them above the compiled hard
ceilings. Frames contain only the final bounded grid and cumulative numeric
counters; raw ANSI and stripped payloads are not retained.

### Terminal control policy

The browser is not a terminal and does not receive terminal escape bytes.
`VirtualTerminal` interprets the small CSI/SGR subset needed for rendering and
strips side channels before projection:

- OSC 52 clipboard reads/writes;
- Kitty graphics APC payloads;
- DCS, APC, PM and SOS device-control strings;
- iTerm2/OSC image and unrelated OSC commands;
- terminal queries, unsupported private modes and unsupported CSI commands;
- unsafe OSC 8 schemes and C0/C1 controls.

Each category has a counter in `VirtualTerminalFrame.stripped`; the payload is
never copied into a frame or log. Incomplete or oversized escape sequences,
writes, input, dimensions and frames fail closed with bounded errors.

## One runtime, one extension instance, one UI owner

A shadow TUI is a presentation of the daemon's existing
`AgentSessionRuntime`. It is not another agent runtime. For an activated
session, the target topology is:

```text
AgentSessionRuntime (sole session state machine and JSONL writer)
  └─ extension runtime (one instance)
      └─ extension UI broker (one controlling presentation)
          └─ InteractiveSessionView
              └─ pi-tui TUI
                  └─ VirtualTerminal
                      └─ bounded frame subscribers (embedded or dedicated Dash)
```

Multiple browser panes may subscribe to the authoritative frame stream, but
must not each call `bindExtensions()` or create another extension runtime. A
controlling pane owns input and extension dialogs; observer panes receive the
same frames. Rich transcript peers remain independent read-only projections.

This follows Pi's existing replacement semantics: when `AgentSessionRuntime`
replaces a session, the old view/broker generation is invalidated, the new
session is bound once, and peers must attach to the new generation.

## Why a child Pi or shadow PTY is rejected

Starting `pi` under a PTY would create a second session state machine and a
second extension instance. If pointed at the same JSONL it also creates a
concurrent writer; if pointed at a copy it immediately diverges from the
session that Dashboard controls. Either choice breaks prompt idempotency,
settlement cursors, tool/UI correlation, runtime replacement and conflict
detection. It also duplicates model/auth/tool setup and introduces an
unbounded terminal-control boundary.

A PTY therefore cannot be the normal compatibility path. Exporting a session
as a new independent session is an explicit ownership operation, not a
rendering technique.

## Pi 0.80.6 audit

The pinned SDK already exports the useful pieces:

- `InteractiveMode`, `AgentSessionRuntime`, Pi message/tool components and
  themes from `@earendil-works/pi-coding-agent`;
- `Terminal`, `TUI`, components, input and ANSI width utilities from
  `@earendil-works/pi-tui`.

The remaining blocker is construction and lifecycle ownership inside
`InteractiveMode`:

1. Its constructor hardcodes `new TUI(new ProcessTerminal(), ...)`.
2. `init()` installs process signal and uncaught-exception handlers and invokes
   `ensureTool("fd")`/`ensureTool("rg")`; the latter may create child
   processes. Neither is acceptable on a daemon's initial no-tools path.
3. shutdown, fatal-error, suspend and external-editor paths own
   `process.exit`, process signals and process suspension.
4. the `TUI`, extension UI context and render trigger are private.
5. `bindCurrentSessionExtensions()` calls `session.bindExtensions(...)`.
   `AgentSession.bindExtensions()` updates bindings **and emits
   `session_start` again**. Attaching a second `InteractiveMode` to a session
   already bound for RPC would replace the extension UI and duplicate
   lifecycle delivery.

The component-level fixture is therefore supported today, while full
interactive extension compatibility needs the small supported seam below.
Pi Daemon does not patch package internals or call private methods in product
code. A test invokes the pinned private differential renderer only to measure
its work until the public view seam exists.

## Minimal upstream API proposal

Add a host-safe `InteractiveSessionView` facade while preserving the current
CLI defaults:

```ts
export interface InteractiveSessionViewHost {
  terminal: Terminal;
  // No default process action is taken when supplied by an embedder.
  requestExit(request: { code: number; reason: string }): void;
  resolveAutocompleteTool?(name: "fd" | "rg"): Promise<string | undefined>;
  suspend?(resume: () => void): void;
  openExternalEditor?(request: ExternalEditorRequest): Promise<string | undefined>;
}

export interface InteractiveSessionViewOptions extends InteractiveModeOptions {
  host: InteractiveSessionViewHost;
  // The embedding host bound the extension runtime once through a stable UI
  // broker. View initialization must not emit session_start again.
  extensionBinding?: "managed" | "external";
}

export interface InteractiveSessionView {
  readonly extensionUI: ExtensionUIContext;
  init(): Promise<void>;       // build/render UI, no model turn
  requestRender(force?: boolean): void;
  stop(): void;                // no process exit
}

export function createInteractiveSessionView(
  runtime: AgentSessionRuntime,
  options: InteractiveSessionViewOptions,
): InteractiveSessionView;
```

Implementation can reuse almost all current `InteractiveMode` code:

- construct `TUI` with `options.host.terminal` instead of a hardcoded
  `ProcessTerminal`;
- move process signal/error/exit/suspend/external-editor behavior into the
  existing CLI host adapter;
- resolve `fd`/`rg` only through the host in embedded mode (absence disables
  the corresponding autocomplete source);
- expose the already-created extension UI context and render request;
- when `extensionBinding` is `external`, skip `bindExtensions()` and let the
  embedding host's stable broker delegate to `view.extensionUI`;
- keep `InteractiveMode.run()` as the process-owning CLI wrapper, preserving
  current behavior by supplying `ProcessTerminal` and the process lifecycle
  adapter.

The extension UI broker must fail closed if a second controlling presentation
tries to attach. Detaching an observer does not change extension bindings.
Session replacement invalidates the broker generation before a replacement
view can receive input.

This is deliberately smaller than a new terminal protocol or a second session
implementation: it only makes the terminal and process/UI ownership that
already exists in `InteractiveMode` injectable and explicit.
