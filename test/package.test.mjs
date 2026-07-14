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
  await symlink(
    join(repositoryRoot, "node_modules"),
    join(destination, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
};

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
      "dist/session-config.js",
      "dist/session-config.d.ts",
      "dist/session-api.schema.json",
      "dist/session-api.openapi.json",
      "THIRD_PARTY_NOTICES.md",
    ]) {
      assert.equal(packageFiles.has(required), true, `packed artifact omitted ${required}`);
    }

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
        'import { PI_DAEMON_VERSION } from "@harryaskham/pi-daemon";',
        'import { SESSION_API_VERSION } from "@harryaskham/pi-daemon/session-api";',
        'import { parseSessionConfiguration } from "@harryaskham/pi-daemon/session-config";',
        'import { DEFAULT_RPC_STDIO_BRIDGE_LIMITS } from "@harryaskham/pi-daemon/rpc-bridge";',
        'import schema from "@harryaskham/pi-daemon/protocol.schema.json" with { type: "json" };',
        'import sessionSchema from "@harryaskham/pi-daemon/session-api.schema.json" with { type: "json" };',
        'import openapi from "@harryaskham/pi-daemon/session-api.openapi.json" with { type: "json" };',
        'const isolation = parseSessionConfiguration({ cwd: process.cwd(), target: { mode: "memory" } }).persistedSpec.isolation?.mode;',
        'process.stdout.write(`${PI_DAEMON_VERSION} ${SESSION_API_VERSION} ${isolation} ${DEFAULT_RPC_STDIO_BRIDGE_LIMITS.reconnectAttempts} ${schema.title} ${sessionSchema.title} ${openapi.openapi}\\n`);',
        "",
      ].join("\n"),
    );
    const imported = await run(process.execPath, [basename(importCheck)], { cwd: consumer });
    assert.equal(
      imported.stdout,
      `${packageVersion} 1.0 unisolated 8 Pi Daemon protocol v1 Pi Daemon additive session API v1 3.1.0\n`,
    );
  },
);
