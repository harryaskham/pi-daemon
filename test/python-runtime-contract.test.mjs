import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("Nix package checks and developer shells provide Python for Android proof contracts", async () => {
  const flake = await readFile(`${root}/flake.nix`, "utf8");

  assert.match(
    flake,
    /nativeBuildInputs = \[pkgs\.makeWrapper pkgs\.openssl pkgs\.bash pkgs\.python3\];/,
  );
  const commonPackages = flake.slice(
    flake.indexOf("commonPackages = ["),
    flake.indexOf("];", flake.indexOf("commonPackages = [")),
  );
  assert.match(commonPackages, /pkgs\.python3/);
});
