# Session summary — Release version invariants

## Goal

Make release publication fail closed unless source metadata, tag, dated changelog, installed npm artifact, and Nix executable all report the same semantic version, while documenting a safe immutable rollback procedure.

## Bead(s)

- `bd-fb3b32` — Enforce version, tag, changelog, package, and Nix release invariants
- Parent: `bd-55ab9e` — Full standalone Pi session host API

## Before state

- Version `0.1.0` was independently hard-coded in package metadata, lockfile, TypeScript, and Nix without an automated agreement check.
- The release workflow did not verify its tag or require a dated changelog before publication.
- The generated npm tarball and Nix executable were not run and compared before GitHub release creation.
- Rollback guidance did not cover npm deprecation or immutable asset/version handling.

## After state

- `scripts/check-release.mjs` validates semantic version agreement across all four metadata sources, exact `vMAJOR.MINOR.PATCH` tags, ISO-dated release notes, and labeled artifact versions.
- Focused tests prove source, lockfile, flake, tag, changelog, and artifact drift are rejected.
- Release CI runs the metadata gate before tests, installs and executes the exact packed tarball, runs the Nix app, and compares both versions before publication.
- The packaged artifact includes the checker, package tests derive expectations from current metadata, and release documentation defines immutable rollback/deprecation steps.

## Diff summary

- Code/content commits: pending final squash SHA from reintegration receipt
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `scripts/check-release.mjs`, `test/release.test.mjs`, `test/package.test.mjs`, `package.json`, `.github/workflows/release.yml`, `docs/release.md`
- Tests: +1 release-invariant test; package artifact test strengthened for version drift and checker inclusion
- Validation: `npm run release:check`; `node --test test/release.test.mjs test/package.test.mjs`; release workflow YAML parse; `git diff --check`
- Behavioural delta: tag publication now fails before release creation on any metadata, changelog, npm artifact, or Nix artifact version mismatch.

## Operator-takeaway

A release can no longer be assembled from mutually inconsistent source and artifacts: the exact npm and Nix deliverables are executed and checked against an immutable tag and dated changelog before GitHub publication.
