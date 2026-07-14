import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { checkRelease } from "../scripts/check-release.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageVersion = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
).version;

const copyReleaseFixture = async (root) => {
  await mkdir(join(root, "src"), { recursive: true });
  for (const file of ["package.json", "package-lock.json", "flake.nix", "CHANGELOG.md"]) {
    await cp(join(repositoryRoot, file), join(root, file));
  }
  await cp(join(repositoryRoot, "src/version.ts"), join(root, "src/version.ts"));
};

test("Pages workflow uses the pinned Nix site build without Docker actions", async () => {
  const workflow = await readFile(join(repositoryRoot, ".github/workflows/pages.yml"), "utf8");
  const flake = await readFile(join(repositoryRoot, "flake.nix"), "utf8");
  assert.doesNotMatch(workflow, /jekyll-build-pages|docker\s+(?:pull|run)|uses:\s*docker/i);
  assert.match(workflow, /nix build \.#pages --print-build-logs/);
  assert.match(workflow, /actions\/upload-pages-artifact@v3/);
  assert.match(workflow, /runs-on: \[self-hosted, nix, x86_64-linux\]/);
  assert.match(flake, /pages = pkgs\.runCommand "pi-daemon-pages"/);
  assert.match(flake, /nativeBuildInputs = \[pkgs\.pandoc\]/);
  assert.match(flake, /link\.target = "\.\.\/" \.\. target/);
  assert.match(flake, /pages = self\.packages\.\$\{system\}\.pages/);
});

test("release invariants reject metadata, tag, changelog, and artifact drift", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-release-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await copyReleaseFixture(root);

  const development = await checkRelease({ root });
  assert.equal(development.version, packageVersion);
  assert.equal(development.changelogLabel, "unreleased");

  const sourcePath = join(root, "src/version.ts");
  const source = await readFile(sourcePath, "utf8");
  await writeFile(sourcePath, source.replace(`"${packageVersion}"`, '"9.9.9"'));
  await assert.rejects(
    checkRelease({ root }),
    (error) => error instanceof Error && error.message.includes("source version 9.9.9 does not match"),
  );
  await writeFile(sourcePath, source);

  const lockPath = join(root, "package-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.packages[""].version = "9.9.9";
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await assert.rejects(
    checkRelease({ root }),
    (error) => error instanceof Error && error.message.includes("lock version 9.9.9 does not match"),
  );
  await cp(join(repositoryRoot, "package-lock.json"), lockPath);

  const flakePath = join(root, "flake.nix");
  const flake = await readFile(flakePath, "utf8");
  await writeFile(
    flakePath,
    flake.replace(`version = "${packageVersion}";`, 'version = "9.9.9";'),
  );
  await assert.rejects(
    checkRelease({ root }),
    (error) => error instanceof Error && error.message.includes("flake version 9.9.9 does not match"),
  );
  await writeFile(flakePath, flake);

  await assert.rejects(
    checkRelease({ root, tag: "v9.9.9" }),
    (error) => error instanceof Error && error.message.includes(`does not match v${packageVersion}`),
  );
  await assert.rejects(
    checkRelease({ root, tag: `v${packageVersion}` }),
    /must use an ISO release date/,
  );

  const changelogPath = join(root, "CHANGELOG.md");
  const changelog = await readFile(changelogPath, "utf8");
  await writeFile(
    changelogPath,
    changelog.replace(`${packageVersion} — unreleased`, `${packageVersion} — 2026-07-14`),
  );
  const release = await checkRelease({
    root,
    tag: `v${packageVersion}`,
    artifactVersions: [
      ["npm", packageVersion],
      ["nix", packageVersion],
    ],
  });
  assert.equal(release.changelogLabel, "2026-07-14");
  await assert.rejects(
    checkRelease({
      root,
      tag: `v${packageVersion}`,
      artifactVersions: [["npm", "9.9.9"]],
    }),
    /npm artifact version 9\.9\.9 does not match/,
  );
});
