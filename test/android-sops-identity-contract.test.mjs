import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const script = path.join(rootDir, "android/build-logic/materialize-sops-identity.sh");
const credentialNames = [
  "PI_DROID_SOPS_AGE_KEY",
  "PI_DROID_SOPS_SSH_PRIVATE_KEY",
  "PI_DROID_SOPS_AGE_KEY_FILE",
  "PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE",
];

async function runFixture({ environment = {}, prepare }) {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "pi-droid-sops-identity-"));
  const runnerTemp = path.join(fixtureRoot, "runner-temp");
  const githubEnv = path.join(fixtureRoot, "github-env");
  await mkdir(runnerTemp, { recursive: true });
  await writeFile(githubEnv, "", { mode: 0o600 });
  const prepared = prepare ? await prepare(fixtureRoot) : {};

  const childEnvironment = { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_ENV: githubEnv };
  for (const name of credentialNames) delete childEnvironment[name];
  Object.assign(childEnvironment, prepared.environment ?? {}, environment);

  const child = spawn("bash", [script], {
    cwd: rootDir,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  return {
    cleanup: () => rm(fixtureRoot, { recursive: true, force: true }),
    fixtureRoot,
    githubEnv,
    runnerTemp,
    status,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    ...prepared,
  };
}

async function exportedEnvironment(githubEnv) {
  const lines = (await readFile(githubEnv, "utf8")).split("\n").filter(Boolean);
  return Object.fromEntries(lines.map((line) => {
    const separator = line.indexOf("=");
    assert.notEqual(separator, -1, `invalid GITHUB_ENV line: ${line}`);
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

test("Play SOPS identity preflight materializes content and preserves safe file fallback", async (t) => {
  await t.test("age content wins over stale file paths and is private", async () => {
    const secret = "AGE-SECRET-KEY-TEST-ONLY\n";
    const fixture = await runFixture({
      environment: {
        PI_DROID_SOPS_AGE_KEY: secret,
        PI_DROID_SOPS_AGE_KEY_FILE: "/missing/stale-age-path",
        PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE: "/missing/stale-ssh-path",
      },
    });
    try {
      assert.equal(fixture.status, 0, fixture.stderr);
      assert.equal(fixture.stdout, "");
      assert.doesNotMatch(fixture.stderr, /AGE-SECRET-KEY-TEST-ONLY/);
      const exported = await exportedEnvironment(fixture.githubEnv);
      assert.equal(exported.PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE, "");
      assert.equal(
        exported.PI_DROID_SOPS_AGE_KEY_FILE,
        path.join(fixture.runnerTemp, "pi-droid-sops-identity/age-identity.txt"),
      );
      assert.equal(await readFile(exported.PI_DROID_SOPS_AGE_KEY_FILE, "utf8"), secret);
      assert.equal((await stat(exported.PI_DROID_SOPS_AGE_KEY_FILE)).mode & 0o777, 0o600);
      assert.equal((await stat(path.dirname(exported.PI_DROID_SOPS_AGE_KEY_FILE))).mode & 0o777, 0o700);
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("SSH content materializes without leaking content", async () => {
    const secret = "-----BEGIN TEST PRIVATE KEY-----\nnot-a-real-key\n-----END TEST PRIVATE KEY-----\n";
    const fixture = await runFixture({
      environment: { PI_DROID_SOPS_SSH_PRIVATE_KEY: secret },
    });
    try {
      assert.equal(fixture.status, 0, fixture.stderr);
      assert.equal(fixture.stdout, "");
      assert.doesNotMatch(fixture.stderr, /not-a-real-key/);
      const exported = await exportedEnvironment(fixture.githubEnv);
      assert.equal(exported.PI_DROID_SOPS_AGE_KEY_FILE, "");
      assert.equal(
        exported.PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE,
        path.join(fixture.runnerTemp, "pi-droid-sops-identity/ssh-private-key"),
      );
      assert.equal(await readFile(exported.PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE, "utf8"), secret);
      assert.equal((await stat(exported.PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE)).mode & 0o777, 0o600);
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("readable file path is exported without copying", async () => {
    const fixture = await runFixture({
      prepare: async (fixtureRoot) => {
        const sourceFile = path.join(fixtureRoot, "preprovisioned-ssh-key");
        await writeFile(sourceFile, "fixture-key\n", { mode: 0o600 });
        return { environment: { PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE: sourceFile }, sourceFile };
      },
    });
    try {
      assert.equal(fixture.status, 0, fixture.stderr);
      const exported = await exportedEnvironment(fixture.githubEnv);
      assert.equal(exported.PI_DROID_SOPS_AGE_KEY_FILE, "");
      assert.equal(exported.PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE, fixture.sourceFile);
      assert.equal(await readFile(fixture.sourceFile, "utf8"), "fixture-key\n");
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("missing identity fails before materialization", async () => {
    const fixture = await runFixture({});
    try {
      assert.equal(fixture.status, 78);
      assert.match(fixture.stderr, /identity content or readable file must be configured/);
      assert.equal(await readFile(fixture.githubEnv, "utf8"), "");
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("unreadable identity path fails without exposing it", async () => {
    const fixture = await runFixture({
      prepare: async (fixtureRoot) => {
        const unreadableFile = path.join(fixtureRoot, "unreadable-key");
        await writeFile(unreadableFile, "not-readable\n", { mode: 0o600 });
        await chmod(unreadableFile, 0o000);
        return { environment: { PI_DROID_SOPS_AGE_KEY_FILE: unreadableFile }, unreadableFile };
      },
    });
    try {
      assert.equal(fixture.status, 66);
      assert.match(fixture.stderr, /must name a readable file/);
      assert.doesNotMatch(fixture.stderr, /not-readable/);
      assert.equal(await readFile(fixture.githubEnv, "utf8"), "");
    } finally {
      await fixture.cleanup();
    }
  });
});
