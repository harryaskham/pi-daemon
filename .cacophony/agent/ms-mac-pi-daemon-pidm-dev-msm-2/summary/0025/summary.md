# Session summary — clean install check after dependency rebases

## Outcome

Completed `bd-2c6d58`: agent and contributor workflows now explicitly check
stale untracked npm installs before calling a dependency-changing mainline
rebase broken.

## Documentation

- `AGENTS.md` workflow now requires an exact-lock `npm ci --ignore-scripts`
  refresh after rebasing across `package.json`, `package-lock.json`, or
  `npm-shrinkwrap.json` before classifying new-package or type-contract errors as
  broken main.
- `CONTRIBUTING.md` explains the specific tell: untouched contracts reporting
  missing imports/old types immediately after crossing dependency metadata.
- The workflow compares the installed package version with reviewed metadata,
  refreshes without lifecycle scripts, and reruns the smallest failing command.
- The boundary remains explicit: real manifest/lock omissions route to their
  owning bead, and failures surviving the clean exact install retain their
  stderr and route normally. The check prevents misdirected peer reports; it
  does not explain away source regressions.
- Updated `PLAN.md` and `CHANGELOG.md`.

## Validation

- `git diff --check`: green.
- `npm test`: 534/534 green.
- `nix flake check`: exit 0 in the foreground. The first client invocation hit
  its one-hour tool ceiling while the daemon still built the package; rerunning
  the identical gate collected the cached successful terminal verdict without
  changing any source or gate.
