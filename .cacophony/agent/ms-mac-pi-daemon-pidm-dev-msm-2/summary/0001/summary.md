# Session summary — Self-hosted workflow migration

## Goal

Move every Pi Daemon GitHub Actions job onto the operator-owned self-hosted runner pools while keeping Linux, macOS, Pages, and release behavior explicit and removing release-script assumptions that failed on minimal runner PATHs.

## Bead(s)

- `bd-e53e76` — Restrict GitHub CI to self-hosted runners
- Parent: `bd-55ab9e` — Full standalone Pi session host API

## Before state

- Node CI, Pages build/deploy, and release used `ubuntu-latest`.
- Nix CI selected `ubuntu-latest` and `macos-14` through a hosted-runner matrix.
- Release packaging required ambient `jq` and `sha256sum`, which are not guaranteed on the self-hosted release lane.

## After state

- Node, Pages, and release jobs use `[self-hosted, nix, x86_64-linux]`.
- Nix CI uses an explicit self-hosted Linux/Nix runner and self-hosted macOS runner matrix.
- Release tarball JSON parsing and SHA-256 generation use the configured Node runtime, eliminating ambient `jq` and `sha256sum` dependencies.
- No GitHub-hosted runner label remains in the repository workflows.

## Diff summary

- Code/content commits: pending final squash SHA from reintegration receipt
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `.github/workflows/ci.yml`, `.github/workflows/pages.yml`, `.github/workflows/release.yml`
- Tests: no runtime tests added; workflow source contract validated directly
- Validation: Ruby parsed all three workflow YAML files; source scan found no hosted runner labels; the exact Node-based release pack/checksum script produced and verified an npm tarball; `git diff --check` passed
- Behavioural delta: all automation is scheduled only on the operator's self-hosted pools and release packaging no longer depends on missing host utilities.

## Operator-takeaway

The repository no longer sends CI, Pages, or release work to GitHub-hosted machines, and the release path is robust to the deliberately minimal PATH on the self-hosted Linux/Nix runner.
