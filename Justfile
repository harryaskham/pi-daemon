set shell := ["bash", "-euo", "pipefail", "-c"]

test-helper := "./scripts/pi-daemon-test-instance.sh"

# First-run safe config + exact main Nix build/test + isolated tmux start.
test-daemon:
    {{test-helper}} install

# Create the owner-private config without cloning/building or overwriting one.
test-daemon-config:
    {{test-helper}} init-config

# Fast-forward, rebuild/test exact main, atomically switch, restart if running.
test-daemon-update:
    {{test-helper}} update

test-daemon-start:
    {{test-helper}} start

test-daemon-stop:
    {{test-helper}} stop

test-daemon-restart:
    {{test-helper}} restart

test-daemon-status:
    {{test-helper}} status

test-daemon-logs:
    {{test-helper}} logs

test-daemon-attach:
    {{test-helper}} attach

# Dash browser acceptance inside the Nix shell that supplies audited Playwright
# browsers. Pass Playwright arguments through, e.g.
# `just dash-e2e --grep 'dormant preview'`.
dash-e2e *ARGS:
    nix develop .#e2e --command npm run e2e:nix --workspace @harryaskham/pi-daemon-dash -- {{ARGS}}

# Refresh the pinned Nix npm dependency hash after a package-lock.json change.
# An automated dependency bump cannot do this, so run it before landing one.
npm-deps-hash:
    npm run nix:deps-hash

# Verify the pinned Nix npm dependency hash without changing it.
npm-deps-hash-check:
    npm run nix:deps-hash:check

# Format the Nix sources with the formatter flake.nix declares.
nix-fmt:
    nix fmt -- flake.nix nix/

# Verify Nix formatting without changing anything; CI runs the same check.
nix-fmt-check:
    nix fmt -- --check flake.nix nix/

# Focused Node test loop: compiles src/ only and reuses the existing Dash SPA.
# e.g. `just test-src test/session-api.test.mjs`. Use `npm test` as the gate.
test-src *ARGS:
    npm run test:src -- {{ARGS}}

# The bounded `@smoke` subset that CI runs on every push and pull request.
# Proves the SPA builds, boots, and stays browser-clean without gating on the
# full suite's runtime or its load-sensitive scenarios.
dash-e2e-smoke:
    nix develop .#e2e --command npm run e2e:smoke --workspace @harryaskham/pi-daemon-dash
