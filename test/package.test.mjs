import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
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

const copyPackageSource = async (destination) => {
  for (const file of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "protocol.schema.json",
    "CHANGELOG.md",
    "README.md",
    "SECURITY.md",
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

    await assert.rejects(
      access(join(source, "dist")),
      (error) => error instanceof Error && "code" in error && error.code === "ENOENT",
    );

    const packed = await run(
      npmCommand,
      ["pack", "--json", "--silent", "--pack-destination", tarballs],
      { cwd: source },
    );
    const metadata = JSON.parse(packed.stdout);
    assert.equal(metadata.length, 1);
    const packageFiles = new Set(metadata[0].files.map((entry) => entry.path));
    for (const required of [
      "dist/cli.js",
      "dist/index.js",
      "dist/index.d.ts",
      "dist/protocol.schema.json",
      "scripts/check-release.mjs",
    ]) {
      assert.equal(packageFiles.has(required), true, `packed artifact omitted ${required}`);
    }

    const tarball = join(tarballs, metadata[0].filename);
    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify({ name: "pi-daemon-package-consumer", private: true })}\n`,
    );
    await run(
      npmCommand,
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-save",
        tarball,
      ],
      { cwd: consumer },
    );

    const bin = join(
      consumer,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "pi-daemon.cmd" : "pi-daemon",
    );
    const direct = await run(bin, ["version"], { cwd: consumer });
    assert.equal(direct.stdout, `${packageVersion}\n`);

    const npmExec = await run(npmCommand, ["exec", "--offline", "--", "pi-daemon", "version"], {
      cwd: consumer,
    });
    assert.equal(npmExec.stdout, `${packageVersion}\n`);

    const importCheck = join(consumer, "package-import-check.mjs");
    await writeFile(
      importCheck,
      [
        'import { PI_DAEMON_VERSION } from "@harryaskham/pi-daemon";',
        'import schema from "@harryaskham/pi-daemon/protocol.schema.json" with { type: "json" };',
        'process.stdout.write(`${PI_DAEMON_VERSION} ${schema.title}\\n`);',
        "",
      ].join("\n"),
    );
    const imported = await run(process.execPath, [basename(importCheck)], { cwd: consumer });
    assert.equal(imported.stdout, `${packageVersion} Pi Daemon protocol v1\n`);
  },
);
