# Session summary — SDK blocker audit and native Dashboard TLS

## Goal

Work through MSM0's filed Pi Daemon beads one at a time: first determine whether the pinned Pi SDK security upgrade could truthfully clear its nested advisories, then implement the next available Dash follow-on as a production-grade native HTTPS/WSS and hardened reverse-proxy transport without exposing certificate, private-key, service-bearer, or browser credentials.

## Bead(s)

- `bd-36428f` — Upgrade pinned Pi SDK after nested shrinkwrap security fixes (audited, explicitly blocked, and unclaimed rather than falsely completed).
- `bd-adc22a` — Track upstream Pi release with protobufjs 7.6.5 shrinkwrap (draft dependency created for the external release condition).
- `bd-e89a17` — Dash follow-on: native TLS and hardened remote browser deployment.
- Parent: `bd-ba3623` — Pi Daemon Dash.

## Before state

- Pi Daemon pinned Pi 0.80.6, whose published shrinkwrap produced one high brace-expansion advisory and one moderate protobufjs advisory. Root lock surgery could not truthfully replace shrinkwrapped installed packages.
- Pi 0.81.1 was the latest upstream release. Its shrinkwrap fixed brace-expansion to 5.0.7 but still pinned protobufjs 7.6.4; isolated audit and upstream `main` both confirmed GHSA-j3f2-48v5-ccww remained.
- Dash accepted only loopback HTTP. Remote deployments had to terminate TLS at a loopback reverse proxy, with no native certificate source/rotation contract or content-free health endpoint.
- HTTPS public origins already enabled Secure browser cookies and exact Host/Origin checks, but HSTS, SNI validation, explicit forwarded-authority trust, non-loopback native TLS admission, and Home Manager TLS secret-path options were absent.

## After state

- `bd-36428f` now depends on draft tracker `bd-adc22a`, contains the exact 0.81.1 audit/upstream evidence, and is unclaimed until a Pi release actually ships protobufjs 7.6.5 or newer. No misleading audit-only lockfile change was made.
- Dash supports native HTTPS/WSS on embedded or dedicated lifecycles with TLS 1.2 minimum, one bounded certificate and private-key file or inherited-fd source each, exact HTTPS `publicOrigin`, matching SNI/Host/Origin, and remote non-loopback binds only under native TLS.
- File-backed certificate pairs rotate through a validated secure-context swap. Partial, unreadable, mismatched, invalid, or over-limit material leaves the last valid context active and records only a content-free failure metric. Descriptor material is one-shot and cannot be configured for replay/reload.
- Plaintext listeners remain loopback-only. Reverse-proxy mode verifies but never derives authority from exact loopback `X-Forwarded-Host`/`Proto`/`Port`; forwarded authority is rejected by default and RFC `Forwarded` is always rejected.
- HTTPS public origins emit HSTS and use Secure `__Host-` cookies. `/dash/healthz` is a no-store 204 probe that still enforces Host/proxy authority and exposes no session, backend, path, credential, or certificate data.
- Instance YAML, CLI, package exports, Pages, security/operations/protocol docs, and Home Manager expose the transport policy. Home Manager carries runtime secret paths, never PEM bytes, and asserts paired cert/key inputs plus an HTTPS public origin.

## Diff summary

- Code/content commit: `314235e`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Main implementation: `src/dashboard-tls.ts`, `src/dashboard-server.ts`, `src/config.ts`, `src/cli.ts`, `nix/home-manager-module.nix`, and package/root exports.
- Documentation/board: `docs/dashboard-transport-security.md`, README, security, operations, Dashboard protocol/acceptance, both Plans, changelog, Pages index/check.
- Tests: runtime-generated short-lived OpenSSL fixture helper; file/fd permission and bound checks; native TLS, SNI, HSTS, secure cookies, plaintext downgrade, spoofed/untrusted forwarding, reverse proxy, atomic live rotation, strict config, dedicated CLI, package export, release, Home Manager, and Pages coverage.
- Validation after rebasing on current main: strict TypeScript check passed; focused config/native TLS/dedicated CLI matrix passed 20/20; the clean build/package/release matrix passed 11/11; and the exact aarch64-darwin Home Manager plus Pages derivations built with the secret-path service contract and new transport document. Hosted CI owns the complete npm/Nix gates.

## Operator-takeaway

The dependency bead was not "fixed" by green metadata: current upstream Pi is still vulnerable to the protobufjs advisory, so the board now tells that truth and waits on an exact release. The available follow-on is complete: Dash can now terminate TLS itself or sit safely behind loopback TLS termination, with one canonical public authority, last-good certificate rotation, secret-safe deployment inputs, and direct remote health—without weakening the existing same-origin browser or daemon-bearer boundaries.
