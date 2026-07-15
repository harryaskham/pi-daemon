# Session summary — Secret-safe operator quickstart

## Goal

Publish one concise, prominent GitHub Pages path that takes an operator from collision-free Home Manager services through authenticated session CRUD, durable ticket waiting, stock Pi RPC attachment, ACP connection setup, cleanup, and the honest `unisolated` trust boundary without exposing the service bearer in argv or Nix source.

## Bead(s)

- `bd-71cfa2` — Publish a concise Pi Daemon operator quickstart on GitHub Pages

## Before state

- Operators had accurate component docs for the session API, RPC bridge, ACP adapter, operations, and security, but no single start-to-finish page.
- The Home Manager module (`bd-691be8`) and high-level session CLI (`bd-68e03a`) were being developed in parallel, so the quickstart had to coordinate their exact landed option, service-name, command, and documentation contracts.
- Pages built every Markdown file but did not assert that a quickstart artifact existed, and neither the Pages index nor README gave operators a prominent start-here link.

## After state

- `docs/quickstart.md` covers two collision-free Home Manager instances, owner-only token creation, native service restart/probe, a bearer-via-file-descriptor `curl` helper, bounded ticket waiting, create/list/delete flows, stock `pi-daemon-rpc`, ACP WebSocket settings, and trust limitations.
- README and the Pages index link the quickstart prominently; the page forwards one-shot users to the landed session management CLI.
- The Nix Pages derivation asserts `quickstart/index.html`, and a focused source contract prevents removal of the links, ticket/RPC/ACP guidance, trust statement, or secret-safe curl pattern.
- Generated nested links resolve to the session API, session CLI, and ACP pages.

## Diff summary

- Code/content commit: pending final squash SHA from reintegration receipt
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `docs/quickstart.md`, `docs/index.md`, `README.md`, `PLAN.md`, `CHANGELOG.md`, `flake.nix`, and `test/release.test.mjs`
- Tests: one focused release/Pages contract test added; no tests removed.
- Validation: all Bash blocks pass `bash -n`; the Home Manager Nix block parses; release tests pass 5/5; `nix build .#pages` succeeds; generated quickstart and sibling links are present.
- Behavioural delta: runtime and protocol behavior are unchanged; operator setup and troubleshooting now have one copy/pasteable, secret-safe entry point tied to the shipped module and clients.

## Operator-takeaway

The quickstart is not a parallel configuration story: it is checked against the exact Home Manager, REST ticket, RPC bridge, ACP, and session CLI surfaces that landed beside it. Most importantly, every executable authentication example reads an owner-only token file without expanding bearer bytes into a process argument.
