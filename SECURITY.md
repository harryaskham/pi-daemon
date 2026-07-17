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

A client needing arbitrary code execution or unreviewed extensions must use a
separate process/security domain.
