import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  assert.match(workflow, /- "flake\.nix"/);
  assert.match(workflow, /actions\/upload-pages-artifact@v3/);
  assert.match(workflow, /runs-on: \[self-hosted, nix, x86_64-linux\]/);
  assert.match(flake, /pages = pkgs\.runCommand "pi-daemon-pages"/);
  assert.match(flake, /nativeBuildInputs = \[pkgs\.pandoc\]/);
  assert.match(flake, /link\.target = "\.\.\/" \.\. target/);
  assert.match(flake, /pages = self\.packages\.\$\{system\}\.pages/);
});

test("Pages publishes the Dash protocol, schema, and OpenAPI from the pinned site build", async () => {
  const [workflow, flake, index, protocol, inventory, ownership, serviceApi, shadowTui] =
    await Promise.all([
      readFile(join(repositoryRoot, ".github/workflows/pages.yml"), "utf8"),
      readFile(join(repositoryRoot, "flake.nix"), "utf8"),
      readFile(join(repositoryRoot, "docs/index.md"), "utf8"),
      readFile(join(repositoryRoot, "docs/dashboard-protocol.md"), "utf8"),
      readFile(join(repositoryRoot, "docs/dashboard-inventory.md"), "utf8"),
      readFile(join(repositoryRoot, "docs/dashboard-ownership.md"), "utf8"),
      readFile(join(repositoryRoot, "docs/dashboard-service-api.md"), "utf8"),
      readFile(join(repositoryRoot, "docs/shadow-tui.md"), "utf8"),
    ]);
  assert.match(workflow, /- "dashboard-api\.schema\.json"/);
  assert.match(workflow, /- "dashboard-api\.openapi\.json"/);
  assert.match(workflow, /test -s _site\/dashboard-protocol\/index\.html/);
  assert.match(workflow, /test -s _site\/dashboard-inventory\/index\.html/);
  assert.match(workflow, /test -s _site\/dashboard-ownership\/index\.html/);
  assert.match(workflow, /test -s _site\/dashboard-service-api\/index\.html/);
  assert.match(workflow, /test -s _site\/shadow-tui\/index\.html/);
  assert.match(flake, /cp \$\{\.\/dashboard-api\.schema\.json\} "\$out\/dashboard-api\.schema\.json"/);
  assert.match(flake, /test -s "\$out\/dashboard-protocol\/index\.html"/);
  assert.match(flake, /test -s "\$out\/dashboard-ownership\/index\.html"/);
  assert.match(flake, /test -s "\$out\/dashboard-service-api\/index\.html"/);
  assert.match(flake, /test -s "\$out\/shadow-tui\/index\.html"/);
  assert.match(index, /\[Dash browser\/backend protocol\]\(dashboard-protocol\)/);
  assert.match(index, /\[Dash session inventory\]\(dashboard-inventory\)/);
  assert.match(index, /\[Dash session ownership\]\(dashboard-ownership\)/);
  assert.match(index, /\[Neutral Dash service API\]\(dashboard-service-api\)/);
  assert.match(index, /\[Dash shadow TUI\]\(shadow-tui\)/);
  assert.match(protocol, /daemon service bearer is \*\*server-to-server only\*\*/);
  assert.match(inventory, /31\.58 ms/);
  assert.match(inventory, /formatSessionSourceFingerprint/);
  assert.match(ownership, /direct-co-opt-confirmed-v1/);
  assert.match(ownership, /append-to-origin/);
  assert.match(serviceApi, /pi-daemon-tui\.v1/);
  assert.match(serviceApi, /service bearer/);
  assert.match(protocol, /snapshotFollows: true/);
  assert.match(shadowTui, /second\s+`pi` process/);
  assert.match(shadowTui, /InteractiveSessionView/);
  assert.match(shadowTui, /OSC 52/);
});

test("Dash transcript projector is exported, documented, and included in clean builds", async () => {
  const [manifest, index, readme, docs] = await Promise.all([
    readFile(join(repositoryRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "src/index.ts"), "utf8"),
    readFile(join(repositoryRoot, "README.md"), "utf8"),
    readFile(join(repositoryRoot, "docs/transcript-projection.md"), "utf8"),
  ]);
  assert.equal(
    manifest.exports["./transcript-projector"].import,
    "./dist/transcript-projector.js",
  );
  assert.match(index, /export \* from "\.\/transcript-projector\.js"/);
  assert.match(readme, /docs\/transcript-projection\.md/);
  assert.match(docs, /hydration: "not-requested"/);
  assert.match(docs, /sha256:<base64url digest>/);
});

test("shadow TUI terminal is exported with its audited upstream seam", async () => {
  const [manifest, index, docs, implementation] = await Promise.all([
    readFile(join(repositoryRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "src/index.ts"), "utf8"),
    readFile(join(repositoryRoot, "docs/shadow-tui.md"), "utf8"),
    readFile(join(repositoryRoot, "src/virtual-terminal.ts"), "utf8"),
  ]);
  assert.equal(manifest.exports["./virtual-terminal"].import, "./dist/virtual-terminal.js");
  assert.equal(manifest.dependencies["@earendil-works/pi-tui"], "0.80.6");
  assert.match(index, /export \* from "\.\/virtual-terminal\.js"/);
  assert.match(docs, /extensionBinding\?: "managed" \| "external"/);
  assert.doesNotMatch(implementation, /node:child_process|ProcessTerminal|process\.(?:stdin|stdout)/);
});

test("clean package builds include the content-hashed Dash SPA and secure server exports", async () => {
  const [manifest, index, assets] = await Promise.all([
    readFile(join(repositoryRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "dist/dashboard/index.html"), "utf8"),
    readdir(join(repositoryRoot, "dist/dashboard/assets")),
  ]);
  for (const name of ["dashboard-auth", "dashboard-store", "dashboard-server"]) {
    assert.equal(manifest.exports[`./${name}`].import, `./dist/${name}.js`);
  }
  assert.match(manifest.scripts.build, /npm run web:build/);
  assert.match(index, /\/dash\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.js/);
  assert.equal(
    assets.some((name) => /-[A-Za-z0-9_-]{8,}\.js$/.test(name)),
    true,
  );
});

test("flake publishes the collision-safe multi-instance Home Manager service module", async () => {
  const [flake, module] = await Promise.all([
    readFile(join(repositoryRoot, "flake.nix"), "utf8"),
    readFile(join(repositoryRoot, "nix/home-manager-module.nix"), "utf8"),
  ]);
  assert.match(flake, /homeManagerModules\.pi-daemon = import \.\/nix\/home-manager-module\.nix/);
  assert.match(flake, /homeManagerModules\.default = self\.homeManagerModules\.pi-daemon/);
  assert.match(flake, /home-manager-module = import \.\/nix\/home-manager-module-check\.nix/);
  assert.match(flake, /doCheck = system != "aarch64-linux"/);
  assert.match(module, /systemd\.user\.services/);
  assert.match(module, /launchd\.agents/);
  assert.match(module, /supervisord\.programs/);
  assert.match(module, /Label = "com\.pi-daemon\.\$\{name\}"/);
  assert.match(module, /api\.port is required/);
  assert.match(module, /enabled Pi Daemon APIs must use unique ports/);
  assert.match(module, /stateDir\/api-token on first launch/);
  assert.match(module, /--auth-seed-file/);
  assert.doesNotMatch(module, /PI_DAEMON_BEARER_TOKEN\s*=/);
});

test("Pages publishes a prominent secret-safe operator quickstart", async () => {
  const [readme, index, quickstart, flake] = await Promise.all([
    readFile(join(repositoryRoot, "README.md"), "utf8"),
    readFile(join(repositoryRoot, "docs/index.md"), "utf8"),
    readFile(join(repositoryRoot, "docs/quickstart.md"), "utf8"),
    readFile(join(repositoryRoot, "flake.nix"), "utf8"),
  ]);
  assert.match(readme, /\[Operator quickstart\]\(docs\/quickstart\.md\)/);
  assert.match(index, /\[Operator quickstart\]\(quickstart\)/);
  assert.match(quickstart, /Idempotency-Key: quickstart-create-v1/);
  assert.match(quickstart, /\/v1\/ticket\/\$ticket_id/);
  assert.match(quickstart, /pi-daemon-rpc/);
  assert.match(quickstart, /agent-client-protocol\.v1/);
  assert.match(quickstart, /`isolation\.mode: "unisolated"`/);
  assert.match(quickstart, /stateDir\/api-token/);
  assert.match(quickstart, /seeds `auth\.json`/);
  assert.doesNotMatch(quickstart, /openssl rand/);
  assert.match(quickstart, /--config <\(printf/);
  assert.doesNotMatch(quickstart, /--header ["']Authorization: Bearer/);
  assert.match(flake, /test -s "\$out\/quickstart\/index\.html"/);
});

test("self-hosted workflows bound every job and long-running Nix step", async () => {
  const [ci, pages, release] = await Promise.all([
    readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
    readFile(join(repositoryRoot, ".github/workflows/pages.yml"), "utf8"),
    readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8"),
  ]);
  assert.equal((ci.match(/timeout-minutes: 30/g) ?? []).length, 2);
  assert.match(ci, /nix flake check --print-build-logs\n\s+timeout-minutes: 25/);
  assert.match(ci, /nix run \.#pi-daemon -- version\n\s+timeout-minutes: 5/);
  assert.match(pages, /build:\n\s+runs-on: \[self-hosted, nix, x86_64-linux\]\n\s+timeout-minutes: 20/);
  assert.match(pages, /deploy:\n\s+timeout-minutes: 10/);
  assert.match(release, /release:\n\s+runs-on: \[self-hosted, nix, x86_64-linux\]\n\s+timeout-minutes: 45/);
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
