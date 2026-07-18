# Security policy

## Supported versions

Until the first stable release, only the latest commit on `main` is supported.

## Reporting

Report vulnerabilities privately to the repository owner. Do not open a public
issue containing credentials, prompts, model output, tokens, filesystem paths
that reveal private data, or exploit details.

## Security model

Pi Daemon multiplexes logical sessions inside one Node process. This is a shared
trust boundary, not a sandbox.

The initial release:

- listens on an owner-only Unix socket;
- disables built-in tools and arbitrary extensions;
- canonicalizes and allowlists working roots;
- keeps one SessionManager/settings/event/idempotency domain per session;
- never accepts Cacophony node authority or other ambient orchestration secrets;
- redacts content and credentials from logs/status;
- bounds requests, queues, sessions, events, memory-facing retention, and drain;
- does not automatically replay an accepted request whose crash outcome is
  indeterminate.

`serve` requires an explicit canonical `--allow-root`; a logical cwd must be
under that root and must not overlap the daemon state or Pi credential roots.
The socket directory, socket, state and agent directories, manifests, and
journals are owner-only real paths; absent daemon-owned directories are created
with mode `0700`, while permissive directories and symlinked state files are
refused rather than silently followed. Session files opened by path must stay
inside that logical session's private state directory.

With the API enabled and no external bearer source, first launch atomically
installs a random `0600` bearer at `STATE_DIR/api-token`. A custom Pi agent
directory may seed an absent `auth.json` once from Pi's normal owner-private auth
file, or from an explicit `--auth-seed-file`. Existing credentials are never
overwritten or rotated. Seed and bearer bytes never enter argv, logs, status,
Nix evaluation, manifests, or responses; symlinked, foreign-owned, permissive,
invalid, oversized, or conflicting inputs fail closed.

Pi Daemon Dash has a separate browser authentication boundary. Its absent
default web credential is generated atomically at the owner-only
`STATE_DIR/web-token` and reused; configured credential files receive the same
owner/symlink/size checks. The daemon API service bearer is never sent to
JavaScript, a URL, cookie, workspace, browser
cache, response, or static asset. A dedicated owner-only web credential is
exchanged over an exact same-origin login for a bounded server-side session;
the browser receives only an HMAC-signed opaque `HttpOnly`, `SameSite=Strict`
cookie and a per-session CSRF token. Private routes authenticate before route
matching, mutations require exact Host/Origin/CSRF checks, and restart revokes
all browser sessions. The initial browser listener is loopback-only; remote use
must terminate TLS at a loopback reverse proxy. Packaged hash-named assets use a
deny-by-default CSP and traversal/symlink/writable-file rejection. Workspace
and UI-only overlays are owner-private, byte/count/depth bounded, revisioned,
atomically written, and cannot mutate bind/auth/roots/credentials/resource
policy.

Shadow-TUI output is interpreted inside a bounded `VirtualTerminal`; raw ANSI
is never sent to browser JavaScript. OSC 52 clipboard access, terminal image
payloads, DCS/APC/PM/SOS device channels, unsafe links, terminal queries, and
unsupported controls are stripped without retaining their payloads. The shadow
view shares the one resident session runtime, extension instance, and JSONL
writer; starting a child Pi/PTY against the session is not a supported render
path.

A client needing arbitrary code execution or unreviewed extensions must use a
separate process/security domain.

## Dependency audit baseline

The exact npm lock pins Ajv 8.20.0, outside `GHSA-2g4f-4pwh-qvx6`. Ajv is a
direct development dependency used only by protocol/schema conformance tests;
all call sites construct strict draft-2020 validators without enabling `$data`.
A clean `npm ci --ignore-scripts` followed by the full `npm audit` reports zero
known vulnerabilities for the locked dependency graph.
