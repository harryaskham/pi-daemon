import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const script = path.join(rootDir, "android/build-logic/materialize-play-release-secrets.sh");
const secretNames = [
  "PI_DROID_RELEASE_KEYSTORE_BASE64",
  "PI_DROID_RELEASE_KEY_ALIAS",
  "PI_DROID_RELEASE_STORE_PASSWORD",
  "PI_DROID_RELEASE_KEY_PASSWORD",
  "PI_DROID_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON",
];

async function runFixture(environment) {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "pi-droid-play-release-secrets-"));
  const runnerTemp = path.join(fixtureRoot, "runner-temp");
  const githubEnv = path.join(fixtureRoot, "github-env");
  await mkdir(runnerTemp, { recursive: true });
  await writeFile(githubEnv, "", { mode: 0o600 });

  const childEnvironment = { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_ENV: githubEnv };
  for (const name of secretNames) delete childEnvironment[name];
  Object.assign(childEnvironment, environment);

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
    githubEnv,
    runnerTemp,
    status,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
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

const completeSecrets = {
  PI_DROID_RELEASE_KEYSTORE_BASE64: Buffer.from("fixture-keystore-bytes").toString("base64"),
  PI_DROID_RELEASE_KEY_ALIAS: "fixture-alias",
  PI_DROID_RELEASE_STORE_PASSWORD: "fixture-store-password",
  PI_DROID_RELEASE_KEY_PASSWORD: "fixture-key-password",
  PI_DROID_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: "service_account",
    project_id: "fixture-project",
    client_email: "fixture@example.invalid",
    private_key: "fixture-private-key",
  }),
};

test("Play release secret preflight materializes direct content privately", async (t) => {
  await t.test("complete direct secret set exports private files", async () => {
    const fixture = await runFixture(completeSecrets);
    try {
      assert.equal(fixture.status, 0, fixture.stderr);
      assert.equal(fixture.stdout, "");
      for (const secret of Object.values(completeSecrets)) {
        assert.equal(fixture.stderr.includes(secret), false);
      }

      const exported = await exportedEnvironment(fixture.githubEnv);
      const expectedDirectory = path.join(fixture.runnerTemp, "pi-droid-play-release-secrets");
      assert.deepEqual(Object.keys(exported).sort(), [
        "PI_DROID_PLAY_SERVICE_ACCOUNT_FILE",
        "PI_DROID_RELEASE_KEYSTORE",
        "PI_DROID_RELEASE_KEY_ALIAS_FILE",
        "PI_DROID_RELEASE_KEY_PASSWORD_FILE",
        "PI_DROID_RELEASE_STORE_PASSWORD_FILE",
      ].sort());
      for (const exportedPath of Object.values(exported)) {
        assert.equal(path.dirname(exportedPath), expectedDirectory);
        assert.equal((await stat(exportedPath)).mode & 0o777, 0o600);
      }
      assert.equal((await stat(expectedDirectory)).mode & 0o777, 0o700);
      assert.equal(await readFile(exported.PI_DROID_RELEASE_KEYSTORE, "utf8"), "fixture-keystore-bytes");
      assert.equal(await readFile(exported.PI_DROID_RELEASE_KEY_ALIAS_FILE, "utf8"), "fixture-alias");
      assert.equal(
        await readFile(exported.PI_DROID_RELEASE_STORE_PASSWORD_FILE, "utf8"),
        "fixture-store-password",
      );
      assert.equal(
        await readFile(exported.PI_DROID_RELEASE_KEY_PASSWORD_FILE, "utf8"),
        "fixture-key-password",
      );
      assert.deepEqual(
        JSON.parse(await readFile(exported.PI_DROID_PLAY_SERVICE_ACCOUNT_FILE, "utf8")),
        JSON.parse(completeSecrets.PI_DROID_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("missing direct secret fails before writing paths", async () => {
    const incomplete = { ...completeSecrets };
    delete incomplete.PI_DROID_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
    const fixture = await runFixture(incomplete);
    try {
      assert.equal(fixture.status, 78);
      assert.match(fixture.stderr, /required Play release secret is missing/);
      assert.equal(await readFile(fixture.githubEnv, "utf8"), "");
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("invalid keystore base64 fails without exporting paths", async () => {
    const fixture = await runFixture({
      ...completeSecrets,
      PI_DROID_RELEASE_KEYSTORE_BASE64: "not-valid-base64%%%",
    });
    try {
      assert.notEqual(fixture.status, 0);
      assert.equal(await readFile(fixture.githubEnv, "utf8"), "");
      assert.doesNotMatch(fixture.stderr, /fixture-store-password|fixture-key-password|fixture-private-key/);
    } finally {
      await fixture.cleanup();
    }
  });
});
