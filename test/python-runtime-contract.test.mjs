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

test("every plain Node CI version provides pinned Python before Android proof contracts run", async () => {
  const workflow = await readFile(`${root}/.github/workflows/ci.yml`, "utf8");
  const nodeJobStart = workflow.indexOf("\n  node:");
  const nodeJobEnd = workflow.indexOf("\n  nix:", nodeJobStart);
  assert.ok(nodeJobStart >= 0 && nodeJobEnd > nodeJobStart);

  const nodeJob = workflow.slice(nodeJobStart, nodeJobEnd);
  assert.match(nodeJob, /node: \["22\.19\.0", "24"\]/);
  const providePython = nodeJob.indexOf("name: Provide the Android proof contracts' Python dependency");
  const runTests = nodeJob.indexOf("- run: npm test");
  assert.ok(providePython >= 0 && providePython < runTests);
  const provisionStep = nodeJob.slice(providePython, runTests);
  assert.match(
    provisionStep,
    /python_out="\$\(nix build --no-link --print-out-paths --inputs-from \. 'nixpkgs#python3'\)"/,
  );
  assert.match(provisionStep, /printf '%s\\n' "\$python_out\/bin" >> "\$GITHUB_PATH"/);
});
