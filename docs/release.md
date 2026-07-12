---
layout: default
title: Release
---

# Release checklist

Pi Daemon releases are Git tags (`vMAJOR.MINOR.PATCH`) on a clean, tested `main`.
The release workflow builds the npm tarball, writes a SHA-256 checksum, and
creates GitHub release notes. Publishing to the npm registry remains an
explicit operator action.

## Before tagging

1. Confirm `package.json`, `src/version.ts`, and the intended tag agree.
2. Move the changelog entry from “unreleased” to the release date.
3. Run `npm ci --ignore-scripts`, `npm test`, and `npm run pack:check`.
4. Run the optional credentialed acceptance harness when model/provider behavior changed.
5. Confirm Linux and macOS Nix checks and `nix run .#pi-daemon -- version` are green.
6. Confirm Pages deploys and the protocol schema link resolves.
7. Verify no prompt, model output, credential, environment, or private path is in logs/artifacts.

## Tag

```console
git tag -s v0.1.0 -m "pi-daemon v0.1.0"
git push origin v0.1.0
```

The workflow uploads `harryaskham-pi-daemon-<version>.tgz` and its checksum.
Consumers should pin a tag or commit and make the Pi Daemon nixpkgs input
follow their own fleet input.

## Rollback

Do not move or force-push a published tag. If a release is bad, mark the GitHub
release accordingly and cut a new patch version. A supervisor can roll back by
pinning the prior tag; durable protocol major version 1 remains compatible with
minor additive fields.
