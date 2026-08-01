# Session summary — supported Vitest passing-test diagnostics

## Outcome

Completed `bd-0ab4f6`: the web suite now has one named, bounded diagnostic seam
that remains visible for passing Vitest tests under the default reporter.

## Implementation

- Added `web/src/test/test-diagnostic.ts` with `reportTestDiagnostic`:
  - exactly one non-empty line;
  - maximum 4,096 characters;
  - refuses LF, CR, and NUL;
  - stderr-first in Node because Vitest hides passing `console.*` output;
  - injected writer for direct tests;
  - console fallback outside Node.
- Routed `reportPerformanceBudget` through the shared helper without changing
  its output or opt-in enforcement semantics.
- Added direct tests for injected/default output and empty/multiline/NUL/oversize
  refusal.
- Documented `reportTestDiagnostic` in `CONTRIBUTING.md` as the supported channel
  rather than a reason to change global reporter behavior or write independent
  raw stderr workarounds; updated `PLAN.md` and `CHANGELOG.md`.

## Validation

- Focused diagnostic + performance reporter suites: 10/10 green.
- Real default-reporter proof: a passing 10k session-tree test printed
  `performance-budget session tree 10k virtual-list preparation: ...` and
  exited 0.
- `npm test`: 531/531 green on the final rerun. An earlier run had one unrelated
  clean-package child timeout under load; the unchanged package suite then
  passed 4/4 and the coherent full rerun passed.
- `nix flake check`: exit 0 in the foreground.
