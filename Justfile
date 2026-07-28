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
