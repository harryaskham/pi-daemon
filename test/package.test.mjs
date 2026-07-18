import assert from "node:assert/strict";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageVersion = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
).version;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const run = async (command, args, options = {}) =>
  execFileAsync(command, args, {
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });

const writableNpmEnvironment = async (temporaryRoot) => {
  const configuredCache = process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE;
  if (configuredCache === undefined) {
    return { environment: process.env, canInstallFromRegistryCache: true };
  }
  try {
    await access(configuredCache, constants.W_OK);
    return { environment: process.env, canInstallFromRegistryCache: true };
  } catch {
    const writableCache = join(temporaryRoot, "npm-cache");
    await mkdir(writableCache, { recursive: true });
    return {
      environment: { ...process.env, npm_config_cache: writableCache },
      canInstallFromRegistryCache: false,
    };
  }
};

const stagePackedPackageWithoutRegistry = async (tarball, consumer, temporaryRoot) => {
  const extracted = join(temporaryRoot, "extracted");
  await mkdir(extracted, { recursive: true });
  await run("tar", ["-xzf", tarball, "-C", extracted]);
  const packageRoot = join(consumer, "node_modules", "@harryaskham", "pi-daemon");
  await mkdir(join(consumer, "node_modules", "@harryaskham"), { recursive: true });
  await cp(join(extracted, "package"), packageRoot, { recursive: true });
  await symlink(
    join(repositoryRoot, "node_modules", "@earendil-works"),
    join(consumer, "node_modules", "@earendil-works"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await symlink(
    join(repositoryRoot, "node_modules", "@agentclientprotocol"),
    join(consumer, "node_modules", "@agentclientprotocol"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await symlink(
    join(repositoryRoot, "node_modules", "ws"),
    join(consumer, "node_modules", "ws"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await mkdir(join(consumer, "node_modules", ".bin"), { recursive: true });
  await symlink(
    "../@harryaskham/pi-daemon/dist/cli.js",
    join(consumer, "node_modules", ".bin", "pi-daemon"),
  );
  await symlink(
    "../@harryaskham/pi-daemon/dist/rpc-stdio-cli.js",
    join(consumer, "node_modules", ".bin", "pi-daemon-rpc"),
  );
};

const copyPackageSource = async (destination) => {
  for (const file of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "protocol.schema.json",
    "session-api.schema.json",
    "session-api.openapi.json",
    "dashboard-api.schema.json",
    "dashboard-api.openapi.json",
    "CHANGELOG.md",
    "README.md",
    "SECURITY.md",
    "THIRD_PARTY_NOTICES.md",
    "LICENSE",
  ]) {
    await cp(join(repositoryRoot, file), join(destination, file));
  }
  await cp(join(repositoryRoot, "scripts"), join(destination, "scripts"), { recursive: true });
  await cp(join(repositoryRoot, "src"), join(destination, "src"), { recursive: true });
  await cp(join(repositoryRoot, "web"), join(destination, "web"), { recursive: true });
  await symlink(
    join(repositoryRoot, "node_modules"),
    join(destination, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
};

test("schema conformance uses the audited exact Ajv pin without $data", async () => {
  const packageManifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  const lock = JSON.parse(await readFile(join(repositoryRoot, "package-lock.json"), "utf8"));
  const lockedAjv = lock.packages["node_modules/ajv"];

  assert.equal(packageManifest.dependencies?.ajv, undefined);
  assert.equal(packageManifest.devDependencies?.ajv, "8.20.0");
  assert.equal(lock.packages[""].devDependencies.ajv, "8.20.0");
  assert.equal(lockedAjv.version, "8.20.0");
  assert.match(lockedAjv.resolved, /^https:\/\/registry\.npmjs\.org\/ajv\//);
  assert.match(lockedAjv.integrity, /^sha512-/);

  for (const file of [
    "test/protocol.test.mjs",
    "test/session-api-contract.test.mjs",
    "test/dashboard-contract.test.mjs",
  ]) {
    const source = await readFile(join(repositoryRoot, file), "utf8");
    assert.match(source, /new Ajv2020\(\{ allErrors: true, strict: true \}\)/);
    assert.doesNotMatch(source, /\$data\s*:/);
  }
});

test(
  "clean npm pack builds runtime files and the installed CLI executes through npm bin links",
  { timeout: 180_000 },
  async (t) => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-daemon-package-"));
    t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
    const source = join(temporaryRoot, "source");
    const tarballs = join(temporaryRoot, "tarballs");
    const consumer = join(temporaryRoot, "consumer");
    await Promise.all([
      mkdir(source, { recursive: true }),
      mkdir(tarballs, { recursive: true }),
      mkdir(consumer, { recursive: true }),
    ]);
    await copyPackageSource(source);
    const { environment: npmEnvironment, canInstallFromRegistryCache } =
      await writableNpmEnvironment(temporaryRoot);

    await assert.rejects(
      access(join(source, "dist")),
      (error) => error instanceof Error && "code" in error && error.code === "ENOENT",
    );

    const packed = await run(
      npmCommand,
      ["pack", "--json", "--silent", "--pack-destination", tarballs],
      { cwd: source, env: npmEnvironment },
    );
    const metadata = JSON.parse(packed.stdout);
    assert.equal(metadata.length, 1);
    const packageFiles = new Set(metadata[0].files.map((entry) => entry.path));
    for (const required of [
      "dist/cli.js",
      "dist/acp-adapter.js",
      "dist/acp-adapter.d.ts",
      "dist/api-auth.js",
      "dist/api-server.js",
      "dist/rpc-attachments.js",
      "dist/rpc-bridge.js",
      "dist/rpc-bridge.d.ts",
      "dist/rpc-stdio-cli.js",
      "dist/websocket.js",
      "dist/index.js",
      "dist/index.d.ts",
      "dist/pi-rpc-controller.js",
      "dist/pi-rpc-controller.d.ts",
      "dist/protocol.schema.json",
      "scripts/check-release.mjs",
      "dist/session-api.js",
      "dist/session-api.d.ts",
      "dist/session-client.js",
      "dist/session-client.d.ts",
      "dist/session-cli.js",
      "dist/session-cli.d.ts",
      "dist/session-config.js",
      "dist/session-config.d.ts",
      "dist/session-api.schema.json",
      "dist/session-api.openapi.json",
      "dist/dashboard-contract.js",
      "dist/dashboard-contract.d.ts",
      "dist/dashboard-backend.js",
      "dist/dashboard-backend.d.ts",
      "dist/dashboard-fixtures.js",
      "dist/dashboard-fixtures.d.ts",
      "dist/dashboard-auth.js",
      "dist/dashboard-auth.d.ts",
      "dist/dashboard-store.js",
      "dist/dashboard-store.d.ts",
      "dist/dashboard-server.js",
      "dist/dashboard-server.d.ts",
      "dist/dashboard-neutral-api.js",
      "dist/dashboard-neutral-api.d.ts",
      "dist/dashboard-tui-attachments.js",
      "dist/dashboard-tui-attachments.d.ts",
      "dist/dashboard/index.html",
      "dist/session-inventory.js",
      "dist/session-inventory.d.ts",
      "dist/source-fingerprint.js",
      "dist/source-fingerprint.d.ts",
      "dist/session-ownership.js",
      "dist/session-ownership.d.ts",
      "dist/session-ownership-store.js",
      "dist/session-ownership-store.d.ts",
      "dist/transcript-projector.js",
      "dist/transcript-projector.d.ts",
      "dist/virtual-terminal.js",
      "dist/virtual-terminal.d.ts",
      "dist/shadow-tui-host.js",
      "dist/shadow-tui-host.d.ts",
      "dist/shadow-tui-attachments.js",
      "dist/shadow-tui-attachments.d.ts",
      "dist/dashboard-api.schema.json",
      "dist/dashboard-api.openapi.json",
      "THIRD_PARTY_NOTICES.md",
    ]) {
      assert.equal(packageFiles.has(required), true, `packed artifact omitted ${required}`);
    }
    assert.equal(
      [...packageFiles].some((file) => /^dist\/dashboard\/assets\/.+-[A-Za-z0-9_-]{8,}\.js$/.test(file)),
      true,
      "packed artifact omitted content-hashed Dash JavaScript",
    );

    const tarball = join(tarballs, metadata[0].filename);
    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify({ name: "pi-daemon-package-consumer", private: true })}\n`,
    );
    if (canInstallFromRegistryCache) {
      await run(
        npmCommand,
        [
          "install",
          "--prefer-offline",
          "--registry=https://registry.npmjs.org",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--no-save",
          tarball,
        ],
        { cwd: consumer, env: npmEnvironment },
      );
    } else {
      // buildNpmPackage exposes a read-only content cache without registry
      // packuments. Nix validates the installed dependency closure separately;
      // stage the tarball and its already-pinned closure for this bin/import smoke.
      await stagePackedPackageWithoutRegistry(tarball, consumer, temporaryRoot);
    }

    const bin = join(
      consumer,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "pi-daemon.cmd" : "pi-daemon",
    );
    await access(bin, constants.X_OK);
    if (process.platform !== "win32") {
      assert.equal((await realpath(bin)).endsWith("/dist/cli.js"), true);
    }
    const direct =
      process.platform === "win32"
        ? await run(bin, ["version"], { cwd: consumer })
        : await run(process.execPath, [bin, "version"], { cwd: consumer });
    assert.equal(direct.stdout, `${packageVersion}\n`);
    const installedHelp =
      process.platform === "win32"
        ? await run(bin, ["help"], { cwd: consumer })
        : await run(process.execPath, [bin, "help"], { cwd: consumer });
    assert.match(installedHelp.stdout, /session list\|show\|create\|update\|delete/);

    const rpcBin = join(
      consumer,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "pi-daemon-rpc.cmd" : "pi-daemon-rpc",
    );
    await access(rpcBin, constants.X_OK);
    if (process.platform !== "win32") {
      assert.equal((await realpath(rpcBin)).endsWith("/dist/rpc-stdio-cli.js"), true);
    }
    const rpcVersion =
      process.platform === "win32"
        ? await run(rpcBin, ["--version"], { cwd: consumer })
        : await run(process.execPath, [rpcBin, "--version"], { cwd: consumer });
    assert.equal(rpcVersion.stdout, `${packageVersion}\n`);

    // In a normal npm install, also exercise npm's platform-specific bin shim.
    // Nix build sandboxes intentionally have no /usr/bin/env, so they execute
    // the resolved bin target with the pinned Node instead.
    let hasSystemEnv = process.platform === "win32";
    if (!hasSystemEnv) {
      try {
        await access("/usr/bin/env", constants.X_OK);
        hasSystemEnv = true;
      } catch {
        hasSystemEnv = false;
      }
    }
    if (canInstallFromRegistryCache && hasSystemEnv) {
      const npmExec = await run(
        npmCommand,
        ["exec", "--offline", "--", "pi-daemon", "version"],
        { cwd: consumer, env: npmEnvironment },
      );
      assert.equal(npmExec.stdout, `${packageVersion}\n`);
    }

    const importCheck = join(consumer, "package-import-check.mjs");
    await writeFile(
      importCheck,
      [
        'import { PI_DAEMON_VERSION, SessionApiClient } from "@harryaskham/pi-daemon";',
        'import { SESSION_API_VERSION } from "@harryaskham/pi-daemon/session-api";',
        'import { parseSessionConfiguration } from "@harryaskham/pi-daemon/session-config";',
        'import { DEFAULT_RPC_STDIO_BRIDGE_LIMITS } from "@harryaskham/pi-daemon/rpc-bridge";',
        'import schema from "@harryaskham/pi-daemon/protocol.schema.json" with { type: "json" };',
        'import sessionSchema from "@harryaskham/pi-daemon/session-api.schema.json" with { type: "json" };',
        'import openapi from "@harryaskham/pi-daemon/session-api.openapi.json" with { type: "json" };',
        'import { DASH_API_VERSION, DASH_DEFAULT_LIMITS } from "@harryaskham/pi-daemon/dashboard-contract";',
        'import { InProcessDashboardBackend } from "@harryaskham/pi-daemon/dashboard-backend";',
        'import { createDashboardContractFixtures } from "@harryaskham/pi-daemon/dashboard-fixtures";',
        'import { DashboardBrowserAuth } from "@harryaskham/pi-daemon/dashboard-auth";',
        'import { DashboardWorkspaceStore } from "@harryaskham/pi-daemon/dashboard-store";',
        'import { DashboardServer } from "@harryaskham/pi-daemon/dashboard-server";',
        'import { EmbeddedDashboardServiceRuntime } from "@harryaskham/pi-daemon/dashboard-service-runtime";',
        'import { DashboardNeutralApiController } from "@harryaskham/pi-daemon/dashboard-neutral-api";',
        'import { UnavailableDashboardTuiAttachments } from "@harryaskham/pi-daemon/dashboard-tui-attachments";',
        'import { ShadowTuiHost } from "@harryaskham/pi-daemon/shadow-tui-host";',
        'import { ShadowTuiAttachmentManager } from "@harryaskham/pi-daemon/shadow-tui-attachments";',
        'import { DEFAULT_SESSION_INVENTORY_LIMITS } from "@harryaskham/pi-daemon/session-inventory";',
        'import { formatSessionSourceFingerprint } from "@harryaskham/pi-daemon/source-fingerprint";',
        'import { TranscriptProjector } from "@harryaskham/pi-daemon/transcript-projector";',
        'import { VirtualTerminal } from "@harryaskham/pi-daemon/virtual-terminal";',
        'import { SessionOwnershipService } from "@harryaskham/pi-daemon/session-ownership";',
        'import { FileSessionOwnershipStore } from "@harryaskham/pi-daemon/session-ownership-store";',
        'import dashSchema from "@harryaskham/pi-daemon/dashboard-api.schema.json" with { type: "json" };',
        'import dashOpenapi from "@harryaskham/pi-daemon/dashboard-api.openapi.json" with { type: "json" };',
        'const isolation = parseSessionConfiguration({ cwd: process.cwd(), target: { mode: "memory" } }).persistedSpec.isolation?.mode;',
        'const dashFixture = createDashboardContractFixtures();',
        'const fingerprint = formatSessionSourceFingerprint(new Uint8Array(32));',
        'process.stdout.write(`${PI_DAEMON_VERSION} ${SESSION_API_VERSION} ${isolation} ${DEFAULT_RPC_STDIO_BRIDGE_LIMITS.reconnectAttempts} ${typeof SessionApiClient} ${schema.title} ${sessionSchema.title} ${openapi.openapi} ${DASH_API_VERSION} ${DASH_DEFAULT_LIMITS.maxInventoryPageItems} ${dashFixture.transcript.hydration} ${dashSchema.title} ${dashOpenapi.openapi} ${DEFAULT_SESSION_INVENTORY_LIMITS.maxSessions} ${fingerprint.slice(0, 7)} ${typeof TranscriptProjector} ${typeof DashboardBrowserAuth} ${typeof DashboardWorkspaceStore} ${typeof DashboardServer} ${typeof EmbeddedDashboardServiceRuntime} ${typeof InProcessDashboardBackend} ${typeof VirtualTerminal} ${typeof SessionOwnershipService} ${typeof FileSessionOwnershipStore} ${typeof DashboardNeutralApiController} ${typeof UnavailableDashboardTuiAttachments} ${typeof ShadowTuiHost} ${typeof ShadowTuiAttachmentManager}\n`);',
        "",
      ].join("\n"),
    );
    const imported = await run(process.execPath, [basename(importCheck)], { cwd: consumer });
    assert.equal(
      imported.stdout,
      `${packageVersion} 1.0 unisolated 8 function Pi Daemon protocol v1 Pi Daemon additive session API v1 3.1.0 1.0 100 not-requested Pi Daemon Dash browser API v1 3.1.0 10000 sha256: function function function function function function function function function function function function function\n`,
    );
  },
);
