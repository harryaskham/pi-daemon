# Exact fixed-output npm dependency cache shared by the package build, CI cache
# pre-materialization, and the hash oracle.
#
# `prefetch-npm-deps` already retries request-level network errors, but a whole
# tarball transfer can still exhaust that internal budget (for example curl 92
# HTTP/2 framing failures). The outer wrapper retries only a narrow reviewed set
# of transport failures. Integrity, package identity, lock, and all unknown
# failures remain immediate and the fixed-output hash remains authoritative.
{
  pkgs,
  lockfile ? ../package-lock.json,
  fetcherVersion ? 2,
  hash,
  name ? "pi-daemon-npm-deps",
  maxAttempts ? 3,
  initialBackoffSecs ? 2,
}: let
  base = pkgs.fetchNpmDeps {
    inherit name fetcherVersion hash;
    src = pkgs.runCommand "pi-daemon-npm-lock" {} ''
      mkdir -p "$out"
      cp ${lockfile} "$out/package-lock.json"
    '';
  };
in
  base.overrideAttrs (_old: {
    # The output is an opaque fixed-output npm cache. Generic fixup recursively
    # scans it for host references and shebangs but cannot improve its integrity;
    # the recursive output hash already commits every byte. Skipping fixup keeps
    # pre-materialization bounded while any content drift still fails the hash.
    dontFixup = true;
    buildPhase = ''
      runHook preBuild

      if [[ -f npm-shrinkwrap.json ]]; then
        srcLockfile="npm-shrinkwrap.json"
      elif [[ -f package-lock.json ]]; then
        srcLockfile="package-lock.json"
      else
        echo "npm dependency source has no package-lock.json or npm-shrinkwrap.json" >&2
        exit 1
      fi

      export outputHash=${pkgs.lib.escapeShellArg hash}
      export PI_DAEMON_NPM_FETCH_MAX_ATTEMPTS=${toString maxAttempts}
      export PI_DAEMON_NPM_FETCH_INITIAL_BACKOFF_SECS=${toString initialBackoffSecs}
      # bd-833b3e: execute through the pinned Nix bash. Calling the source
      # script directly delegates to `#!/usr/bin/env bash`, but `/usr/bin/env`
      # does not exist inside the Nix build sandbox (hosted jobs fail 126).
      ${pkgs.bash}/bin/bash ${../scripts/prefetch-npm-deps-retry.sh} "$srcLockfile" "$out"

      runHook postBuild
    '';
  })
