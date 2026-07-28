# Hash oracle for the pinned `npmDepsHash` in flake.nix.
#
# `buildNpmPackage` derives its npm dependency cache from the lock file alone,
# so the fixed-output hash is a pure function of `package-lock.json` and the
# fetcher version. Reproducing that here from a minimal source lets
# `scripts/refresh-npm-deps-hash.mjs` compute the exact expected hash without
# rebuilding the package, without editing flake.nix mid-run, and without
# needing the working tree to be committed first.
#
# `flake.nix` deliberately keeps owning the real build. `nix flake check` proves
# the two agree: the `npm-deps-hash` check fails if this oracle and the pinned
# hash ever diverge.
{
  pkgs,
  lockfile ? ../package-lock.json,
  fetcherVersion ? 2,
  hash,
}:
pkgs.fetchNpmDeps {
  name = "pi-daemon-npm-deps-oracle";
  src = pkgs.runCommand "pi-daemon-npm-lock" {} ''
    mkdir -p "$out"
    cp ${lockfile} "$out/package-lock.json"
  '';
  inherit fetcherVersion hash;
}
