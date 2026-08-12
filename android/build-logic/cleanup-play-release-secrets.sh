#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_TEMP:?RUNNER_TEMP must be set}"

secret_dir="$RUNNER_TEMP/pi-droid-play-release-secrets"
rm -rf -- "$secret_dir"
