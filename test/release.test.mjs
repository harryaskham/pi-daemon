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
  // The intent is the official artifact action on the Nix-built site, not one
  // major version of it: keeping a literal `@v3` here made a routine action
  // bump look like a product regression. Docker-freeness is asserted above.
  assert.match(workflow, /actions\/upload-pages-artifact@v\d+/);
  assert.match(workflow, /runs-on: \[self-hosted, nix, x86_64-linux\]/);
  // Formatting-insensitive: the `pages` attribute must build with pandoc, but
  // its exact line layout belongs to the repository formatter, not this test.
  assert.match(flake, /pages =\s*\n?\s*pkgs\.runCommand "pi-daemon-pages"/);
  assert.match(flake, /nativeBuildInputs = \[pkgs\.pandoc\]/);
  assert.match(flake, /link\.target = "\.\.\/" \.\. target/);
  assert.match(flake, /pages = self\.packages\.\$\{system\}\.pages/);
});

test("Pages publishes the Dash protocol, schema, and OpenAPI from the pinned site build", async () => {
  const [workflow, flake, index, protocol, inventory, ownership, serviceApi, shadowTui, authorization] =
    await Promise.all([
      readFile(join(repositoryRoot, ".github/workflows/pages.yml"), "utf8"),
      readFile(join(repositoryRoot, "flake.nix"), "utf8"),
      readFile(join(repositoryRoot, "docs/index.md"), "utf8"),
      readFile(join(repositoryRoot, "docs/dashboard-protocol.md"), "utf8"),
      readFile(join(repositoryRoot, "docs/dashboard-inventory.md"), "utf8"),
      readFile(join(repositoryRoot, "docs/dashboard-ownership.md"), "utf8"),
      readFile(join(repositoryRoot, "docs/dashboard-service-api.md"), "utf8"),
      readFile(join(repositoryRoot, "docs/shadow-tui.md"), "utf8"),
      readFile(join(repositoryRoot, "docs/dashboard-authorization.md"), "utf8"),
    ]);
  assert.match(workflow, /- "dashboard-api\.schema\.json"/);
  assert.match(workflow, /- "dashboard-api\.openapi\.json"/);
  assert.match(workflow, /- "schedule\.schema\.json"/);
  assert.match(workflow, /test -s _site\/schedules\/index\.html/);
  assert.match(workflow, /test -s _site\/schedule\.schema\.json/);
  assert.match(workflow, /test -s _site\/dashboard-protocol\/index\.html/);
  assert.match(workflow, /test -s _site\/dashboard-inventory\/index\.html/);
  assert.match(workflow, /test -s _site\/dashboard-ownership\/index\.html/);
  assert.match(workflow, /test -s _site\/dashboard-service-api\/index\.html/);
  assert.match(workflow, /test -s _site\/shadow-tui\/index\.html/);
  assert.match(flake, /cp \$\{\.\/dashboard-api\.schema\.json\} "\$out\/dashboard-api\.schema\.json"/);
  assert.match(flake, /cp \$\{\.\/schedule\.schema\.json\} "\$out\/schedule\.schema\.json"/);
  assert.match(flake, /test -s "\$out\/schedules\/index\.html"/);
  assert.match(flake, /test -s "\$out\/dashboard-protocol\/index\.html"/);
  assert.match(flake, /test -s "\$out\/dashboard-authorization\/index\.html"/);
  assert.match(flake, /test -s "\$out\/dashboard-ownership\/index\.html"/);
  assert.match(flake, /test -s "\$out\/dashboard-service-api\/index\.html"/);
  assert.match(flake, /test -s "\$out\/shadow-tui\/index\.html"/);
  assert.match(index, /\[Dash browser\/backend protocol\]\(dashboard-protocol\)/);
  assert.match(index, /\[Dashboard identity and authorization\]\(dashboard-authorization\)/);
  assert.match(index, /\[Dash session inventory\]\(dashboard-inventory\)/);
  assert.match(index, /\[Dash session ownership\]\(dashboard-ownership\)/);
  assert.match(index, /\[Neutral Dash service API\]\(dashboard-service-api\)/);
  assert.match(index, /\[Dash shadow TUI\]\(shadow-tui\)/);
  assert.match(index, /\[Schedule contract\]\(schedules\)/);
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
  assert.match(authorization, /Existing v1 resources carry no ACL properties/);
  assert.match(authorization, /There is no intermediate mode/);
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
  assert.equal(manifest.dependencies["@earendil-works/pi-tui"], "0.82.1");
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
  for (const name of [
    "self-update",
    "dashboard-auth",
    "dashboard-identity",
    "dashboard-identity-config",
    "installed-package-resources",
    "dashboard-authorization",
    "dashboard-authorization-enforcer",
    "dashboard-authorization-contract",
    "dashboard-controller-coordinator",
    "dashboard-tls",
    "dashboard-backend",
    "dashboard-remote-backend",
    "dashboard-store",
    "dashboard-server",
    "shadow-tui-attachments",
    "shadow-tui-host",
  ]) {
    assert.equal(manifest.exports[`./${name}`].import, `./dist/${name}.js`);
  }
  assert.match(manifest.scripts.build, /npm run web:build/);
  assert.equal(manifest.files.includes("npm-shrinkwrap.json"), true);
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
  assert.match(module, /enabled Pi Daemon API and dedicated Dash services must use unique ports/);
  assert.match(module, /pi-daemon-web-/);
  assert.match(module, /dedicatedWeb\.port is required/);
  assert.match(module, /native TLS requires both tls\.certFile and tls\.keyFile/);
  assert.match(module, /native TLS requires an HTTPS publicOrigin/);
  assert.match(module, /non-loopback plaintext dedicatedWeb\.bind requires allowInsecurePublicOrigin/);
  assert.match(module, /--tls-cert-file/);
  assert.match(module, /--tls-key-file/);
  assert.match(module, /stateDir\/api-token on first launch/);
  assert.match(module, /regular non-symlink bearer token file/);
  assert.doesNotMatch(module, /config\.sops\.secrets\.pi-daemon-work\.path/);
  assert.match(module, /Secret-manager symlinks are refused/);
  assert.match(module, /--auth-seed-file/);
  assert.match(module, /mutableRuntime\.enable/);
  assert.match(module, /\.local\/bin\/pi-daemon/);
  assert.match(module, /pi-daemon-runtime/);
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

test("Pages leads with configured tool-capable sessions without weakening legacy defaults", async () => {
  const [index, readme, quickstart, configuration, sessionConfig, adapter, multiplexer] =
    await Promise.all([
      readFile(join(repositoryRoot, "docs/index.md"), "utf8"),
      readFile(join(repositoryRoot, "README.md"), "utf8"),
      readFile(join(repositoryRoot, "docs/quickstart.md"), "utf8"),
      readFile(join(repositoryRoot, "docs/session-configuration.md"), "utf8"),
      readFile(join(repositoryRoot, "src/session-config.ts"), "utf8"),
      readFile(join(repositoryRoot, "src/pi-adapter.ts"), "utf8"),
      readFile(join(repositoryRoot, "src/multiplexer.ts"), "utf8"),
    ]);

  const configured = index.indexOf("authenticated Session API is the full configured-session surface");
  const legacy = index.indexOf("Legacy owner-only Unix NDJSON v1");
  assert.notEqual(configured, -1, "Pages must name the current configured-session surface");
  assert.notEqual(legacy, -1, "Pages must preserve the legacy v1 compatibility fact");
  assert.equal(configured < legacy, true, "current product capability must lead legacy caveats");
  assert.match(index, /`default`, `none`, `no-builtin`, and\s+`allowlist`/);
  assert.match(index, /not a persistent shell or\s+PTY/);
  assert.match(index, /`maxConcurrentTurns`/);

  assert.match(readme, /Legacy Unix NDJSON v1 and unconfigured browser activations/);
  assert.match(readme, /Configured trusted sessions may deliberately enable Pi built-ins/);
  assert.match(quickstart, /deliberately selects `tools\.mode: "none"`/);
  assert.match(
    quickstart,
    /\[Session configuration and\s+isolation\]\(session-configuration\)/,
  );
  assert.match(configuration, /one active model turn per logical session/);
  assert.match(configuration, /does not provide a persistent\s+shell or PTY/);

  for (const mode of ["default", "none", "no-builtin", "allowlist"]) {
    assert.match(sessionConfig, new RegExp(`case "${mode}"`));
  }
  assert.match(adapter, /createBashTool\(cwd/);
  assert.match(multiplexer, /maxConcurrentTurns/);
});

test("self-hosted workflows bound every job and long-running Nix step", async () => {
  const [ci, macos, pages, release] = await Promise.all([
    readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
    readFile(join(repositoryRoot, ".github/workflows/ci-macos.yml"), "utf8"),
    readFile(join(repositoryRoot, ".github/workflows/pages.yml"), "utf8"),
    readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8"),
  ]);
  // Every job declares its own bound, asserted as a property rather than by
  // counting one literal so a deliberate per-job budget is not a test failure.
  const jobTimeouts = ci.match(/^\s{4}timeout-minutes: .+$/gm) ?? [];
  assert.equal(jobTimeouts.length, 3, "every CI job must declare its own timeout");
  assert.match(ci, /timeout-minutes: \$\{\{ matrix\.jobTimeout \}\}/);
  assert.match(ci, /jobTimeout: 30\n\s+#.*\n\s+#.*\n\s+checkTimeout: 25/);
  assert.match(
    ci,
    /nix flake check --print-build-logs\n\s+timeout-minutes: \$\{\{ matrix\.checkTimeout \}\}/,
  );
  assert.match(ci, /nix run \.#pi-daemon -- version\n\s+timeout-minutes: 5/);
  // The fast lane cancels superseded runs. Holding them deadlocked CI: a job
  // that cannot be assigned never completes, so every later run waited behind
  // it and dispatched nothing at all (bd-775c57). Slow verification that must
  // survive a later landing lives in its own workflow and its own group.
  assert.match(ci, /cancel-in-progress: true/);
  assert.doesNotMatch(ci, /\[self-hosted, macos\]/, "macOS must not share the fast lane's group");
  assert.match(macos, /group: ci-macos-\$\{\{ github\.ref \}\}/);
  assert.match(macos, /cancel-in-progress: false/);
  assert.match(macos, /runs-on: \[self-hosted, macos\]\n\s+timeout-minutes: 80/);
  assert.match(macos, /PI_DAEMON_NIX_CI_BUILD_NONCE=github-%s-%s/);
  assert.match(
    macos,
    /run-nix-ci-package\.sh[\s\\]+"\$\{\{ steps\.nix-state\.outputs\.system \}\}"[\s\S]*?timeout-minutes: 75/,
  );
  assert.doesNotMatch(macos, /--rebuild/);
  assert.match(
    macos,
    /nix flake check --impure --print-build-logs[\s\S]*?timeout-minutes: 30/,
  );
  assert.match(macos, /nix run --impure \.#pi-daemon -- version[\s\S]*?timeout-minutes: 5/);
  assert.match(
    ci,
    /dash-smoke:\n\s+name: Dash browser smoke\n\s+runs-on: \[self-hosted, nix, x86_64-linux\]\n\s+timeout-minutes: 20/,
  );
  assert.match(ci, /nix develop \.#e2e --command npm ci --ignore-scripts\n\s+timeout-minutes: 10/);
  assert.match(ci, /nix develop \.#e2e --command npm run web:e2e:smoke\n\s+timeout-minutes: 10/);
  assert.match(ci, /PI_DAEMON_E2E_NO_SANDBOX: "1"/);
  assert.match(pages, /build:\n\s+runs-on: \[self-hosted, nix, x86_64-linux\]\n\s+timeout-minutes: 20/);
  assert.match(pages, /deploy:\n\s+timeout-minutes: 10/);
  assert.match(release, /release:\n\s+runs-on: \[self-hosted, nix, x86_64-linux\]\n\s+timeout-minutes: 45/);
  assert.match(release, /cp package-lock\.json npm-shrinkwrap\.json/);
  assert.match(release, /package\/npm-shrinkwrap\.json/);
  assert.match(release, /steps\.pack\.outputs\.tarball \}\}\.sha256/);
  assert.match(release, /--latest/);
});

test("the CI browser smoke subset is wired end to end and never selects an empty set", async () => {
  const [rootManifest, webManifest, spec, justfile] = await Promise.all([
    readFile(join(repositoryRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "web/package.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "web/e2e/dash.spec.ts"), "utf8"),
    readFile(join(repositoryRoot, "Justfile"), "utf8"),
  ]);
  assert.match(
    webManifest.scripts["e2e:smoke"],
    /playwright test --grep @smoke$/,
    "the smoke script must select the tagged subset",
  );
  assert.equal(
    rootManifest.scripts["web:e2e:smoke"],
    "node scripts/run-web-workspace.mjs e2e:smoke",
  );
  assert.doesNotMatch(
    rootManifest.scripts["web:e2e:smoke"],
    /npm run .*--workspace/,
    "the nested npm form consumes forwarded Playwright flags as npm config",
  );
  assert.match(justfile, /dash-e2e-smoke:\n\s+nix develop \.#e2e --command npm run e2e:smoke/);
  const tagged = spec.match(/^test\("[^"]*@smoke"/gm) ?? [];
  assert.ok(
    tagged.length >= 3,
    `browser smoke subset must keep at least three tagged scenarios, found ${tagged.length}`,
  );
  // Relaxing the browser sandbox must stay opt-in per environment: a developer
  // machine keeps it, and only an explicit variable turns it off (bd-df1c84).
  // Asserted against the exported behaviour rather than config source text, so
  // formatting the config can never be a behavioural change.
  const { NO_SANDBOX_ENV, NO_SANDBOX_ARGS, browserLaunchOptions } = await import(
    new URL("../web/playwright-launch.mjs", import.meta.url)
  );
  assert.equal(NO_SANDBOX_ENV, "PI_DAEMON_E2E_NO_SANDBOX");
  assert.deepEqual(NO_SANDBOX_ARGS, [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-zygote",
  ]);
  assert.deepEqual(browserLaunchOptions({}), {});
  assert.deepEqual(browserLaunchOptions({ [NO_SANDBOX_ENV]: "0" }), {});
  assert.deepEqual(browserLaunchOptions({ [NO_SANDBOX_ENV]: "1" }), { args: NO_SANDBOX_ARGS });
  // The suite must prove the browser can launch before spending minutes
  // failing every scenario with Playwright's causeless closed-target message.
  for (const script of ["e2e:nix", "e2e:smoke"]) {
    assert.match(
      webManifest.scripts[script],
      /check-browser-launch\.mjs/,
      `${script} must run the browser launch preflight`,
    );
  }
});

test("release invariants reject metadata, tag, changelog, and artifact drift", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-release-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await copyReleaseFixture(root);

  const development = await checkRelease({ root });
  assert.equal(development.version, packageVersion);
  assert.match(development.changelogLabel, /^\d{4}-\d{2}-\d{2}$/);

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
  const changelogPath = join(root, "CHANGELOG.md");
  const changelog = await readFile(changelogPath, "utf8");
  await writeFile(
    changelogPath,
    changelog.replace(`${packageVersion} — ${development.changelogLabel}`, `${packageVersion} — unreleased`),
  );
  await assert.rejects(
    checkRelease({ root, tag: `v${packageVersion}` }),
    /must use an ISO release date/,
  );
  await writeFile(
    changelogPath,
    changelog.replace(`${packageVersion} — ${development.changelogLabel}`, `${packageVersion} — 2026-07-14`),
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
