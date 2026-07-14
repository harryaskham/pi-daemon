---
layout: default
title: Release
---

# Release checklist

Pi Daemon releases are Git tags (`vMAJOR.MINOR.PATCH`) on a clean, tested `main`.
The release workflow builds the npm tarball, writes a SHA-256 checksum, and
creates GitHub release notes. Publishing to the npm registry remains an
explicit operator action.

> **Current hold:** do not cut `v0.1.0` from the no-tools scaffold. The
> 2026-07-14 completion audit in `PLAN.md` identified release-blocking runtime,
> durability, API/attach, security, and installed-package work. Tag only after
> the registered full-host acceptance bead closes, or deliberately publish a
> differently named scaffold preview.

## Before tagging

1. Update the version in `package.json`, the root package in `package-lock.json`,
   `src/version.ts`, and `flake.nix` together.
2. Move the matching changelog entry from “unreleased” to the ISO release date.
3. Run `npm run release:check -- --tag vMAJOR.MINOR.PATCH`. The same preflight
   runs before the release workflow builds or publishes anything.
4. Run `npm ci --ignore-scripts`, `npm test`, and `npm run pack:check`.
5. Run the optional credentialed acceptance harness when model/provider behavior changed.
6. Confirm Linux and macOS Nix checks and `nix run .#pi-daemon -- version` are green.
7. Confirm `nix build .#pages` succeeds, the Docker-free Pages workflow deploys,
   and the protocol schema link resolves.
8. Verify no prompt, model output, credential, environment, or private path is in logs/artifacts.

The release workflow installs the exact generated npm tarball and runs its
`pi-daemon version`, then runs the Nix application and compares both versions
with the tag and all four source metadata locations. A mismatch or an
“unreleased” changelog section fails before `gh release create`.

## Tag

```console
git tag -s v0.1.0 -m "pi-daemon v0.1.0"
git push origin v0.1.0
```

The workflow uploads `harryaskham-pi-daemon-<version>.tgz` and its checksum.
Consumers should pin a tag or commit and make the Pi Daemon nixpkgs input
follow their own fleet input.

## Rollback

Do not move or force-push a published tag, overwrite its GitHub assets, or reuse
its npm version. If a release is bad:

1. Mark the GitHub release as withdrawn or pre-release and document the reason.
2. If npm was explicitly published, deprecate that exact version with a concise
   migration message; do not unpublish a version that consumers may have pinned.
3. Repoint supervisors and flake consumers to the prior known-good immutable tag.
4. Fix forward and cut a new patch version with a new dated changelog section.

Durable protocol major version 1 remains compatible with minor additive fields,
but rollback still restores the complete prior package rather than mixing code
or assets between tags.
