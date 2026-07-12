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

A client needing arbitrary code execution or unreviewed extensions must use a
separate process/security domain.
