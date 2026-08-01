# Session summary — stale dist warning for build-free tests

## Outcome

Completed `bd-b771c1`: `npm run test:unit` remains deliberately build-free, but
now distinguishes stale compiled JavaScript from a real source failure before
starting the Node suite.

## Implementation

- Added `scripts/source-dist-fingerprint.mjs`:
  - deterministic SHA-256 over sorted regular `src/**` path+content records;
  - bounded to 10,000 entries, 4 MiB per file, and 64 MiB aggregate;
  - refuses source symlinks rather than hashing ambient files;
  - writes a versioned owner-only `dist/.source-build-fingerprint.json`
    atomically;
  - compares current source to the marker without mutating or rebuilding;
  - missing, malformed, or stale markers produce one path-free warning naming
    `npm run test:src -- <test-file>` / `npm run build:src` and explicitly state
    that tests will still run.
- `scripts/postbuild.mjs` writes the marker after every full or source-only
  compilation.
- `test:unit` runs the checker before `node --test`; it never turns a warning
  into a failure or skip, preserving the fast build-free loop.
- Added five direct tests for package/postbuild wiring, deterministic current
  markers, real source drift, missing/invalid markers, path-free remediation,
  and symlink refusal.
- Updated `CONTRIBUTING.md`, `PLAN.md`, and `CHANGELOG.md`.

## Validation

- Focused fingerprint suite: 5/5 green.
- Actual CLI behavior: an absent marker emitted the warning and exited 0;
  `npm run build:src` wrote a marker (format 1, sha256, 82 source files, 43-char
  digest); the next check was silent.
- `npm test`: 531/531 green.
- `nix flake check`: exit 0 in the foreground.
