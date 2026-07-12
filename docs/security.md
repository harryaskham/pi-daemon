---
layout: default
title: Security
---

# Security

A Pi Daemon process is one operator trust domain, not a sandbox. Logical
sessions isolate state and scheduling; they do not isolate malicious JavaScript
loaded into the same Node process. The initial service therefore loads no
project code or tools.

## Enforced defaults

- owner-only Unix socket in a non-group/world-writable real directory
- owner-only state directories, manifests, and journals
- symlink and traversal refusal for durable state/session paths
- required canonical `--allow-root` for every logical cwd
- cwd must not overlap daemon state or Pi credential roots
- opened Pi session files remain inside that logical session's state directory
- default Pi auth file must be an owner-only regular file
- empty built-in/custom tool allowlist
- empty extensions, skills, templates, themes, context files, and append prompt
- no Cacophony node token, CA key, daemon state, or orchestration authority
- structured logs redact prompts, output/content, environment, and credentials
- accepted wake requests are never blindly replayed after a crash

Prompts and terminal results are necessarily retained in the private durable
request journal so a queued request can be replayed and a duplicate terminal
request can receive its prior result. They are not emitted in status or logs.
Protect the state directory as sensitive application data.

## Separate inhabitants

A workload requiring arbitrary extensions, process tools, filesystem tools, or
unreviewed project JavaScript must run in a separate Pi Daemon process/security
domain. Do not widen the shared no-tools host.

Report vulnerabilities privately to the repository owner; do not include live
credentials, prompts, output, or private paths in a public issue.
