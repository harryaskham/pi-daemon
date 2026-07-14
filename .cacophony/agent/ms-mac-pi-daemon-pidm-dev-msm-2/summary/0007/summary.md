# Session summary — Linux package and Docker-free Pages CI

## Goal

Repair two post-completion Linux CI failures: hermetic Nix package tests could not execute npm bin links, and Pages used the Docker-backed Jekyll action on a self-hosted runner without Docker.

## Bead

- `bd-ba50b5` — Fix Linux package-bin acceptance and make Pages Docker-free with Nix

## Root causes and fixes

### Installed bin ENOENT

The packed CLI scripts correctly use portable `#!/usr/bin/env node`, but a Nix Linux build sandbox intentionally has no `/usr/bin/env`. Directly spawning the npm `.bin` symlink therefore reported ENOENT even though the link and target existed. The hermetic fallback also omitted the newly required `@agentclientprotocol` dependency scope.

The package acceptance now:

- verifies both `.bin` entries are executable and resolve to the packed dist targets;
- executes those targets through the pinned `process.execPath` in hermetic sandboxes;
- retains real `npm exec` bin-shim coverage where `/usr/bin/env` exists;
- stages the ACP dependency scope in registry-less fallback mode; and
- forces both final Nix wrappers through an install-check phase.

A forced registry-less/read-only-cache reproduction passes locally.

### Pages Docker failure

`actions/jekyll-build-pages` is a Docker action and could not run without `/var/run/docker.sock`. The flake now exposes a reproducible `pages` derivation built with pinned nixpkgs Pandoc. It converts every published Markdown document to static HTML, copies protocol/OpenAPI contracts, writes a style sheet and `.nojekyll`, and validates required pages. `checks.<system>.pages` keeps the site in `nix flake check`.

The workflow now runs `nix build .#pages`, copies the immutable result, and uploads it with `upload-pages-artifact`; no Docker/Jekyll build action remains. A source test prevents regression.

## Validation

- Focused package/workflow/release tests: 3/3
- Forced Nix-like registry-less package fallback: 1/1
- Full npm suite: 144/144
- `nix build .#pages`: success; required HTML/contracts present
- `nix flake check`: success on aarch64-darwin, including package tests 144/144, Pages derivation, package install/fixup, and both installed wrapper version checks
- x86_64-linux derivation evaluates; this macOS host has no Linux builder, so authoritative Linux execution remains the post-land self-hosted CI rerun

## Commit

- `bf985af` — hermetic package-bin and Docker-free Pages implementation

## Operator takeaway

The failing Linux path no longer depends on `/usr/bin/env` inside Nix, and Pages no longer depends on Docker at all. Both surfaces are now pinned, reproducible Nix checks rather than runner-ambient assumptions.
