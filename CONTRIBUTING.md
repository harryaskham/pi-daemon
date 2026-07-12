# Contributing

Read `AGENTS.md` and `PLAN.md` first.

## Development

```bash
nix develop
npm ci
npm test
nix flake check
```

Changes should be narrow, tested, and documented. Protocol changes require a
versioning assessment, fixtures, and compatibility coverage. Security-sensitive
changes require adversarial tests.

## Commits and pull requests

Use concise imperative commit subjects and include the relevant provisional
`PD-...` identifier while the formal board is not configured. Explain behavior,
compatibility, tests, and security impact in pull requests.

## Reporting defects

Include the pi-daemon version, Node version, platform, operation/error code, and
redacted reproduction. Never attach auth files, prompts, model output, tokens,
or environment dumps.
