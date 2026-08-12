import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const helperPath = path.join(rootDir, "android/build-logic/prove-kvm-runner-capability.sh");

async function source(relativePath) {
  return readFile(path.join(rootDir, relativePath), "utf8");
}

async function runHelper(overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-droid-kvm-contract-"));
  const output = path.join(root, "github-output");
  const receipt = path.join(root, "receipt", "kvm.json");
  await writeFile(output, "", { mode: 0o600 });
  const environment = {
    ...process.env,
    GITHUB_ACTIONS: "true",
    GITHUB_OUTPUT: output,
    GITHUB_REPOSITORY: "fixture/pi-daemon",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "1234",
    RUNNER_ARCH: "X64",
    RUNNER_NAME: "fixture-runner",
    RUNNER_OS: "Linux",
    RUNNER_TEMP: root,
    PI_DROID_KVM_RECEIPT_FILE: receipt,
    ...overrides,
  };
  const child = spawn("bash", [helperPath], {
    cwd: rootDir,
    env: environment,
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
    cleanup: () => rm(root, { recursive: true, force: true }),
    output,
    receipt,
    status,
    stderr: Buffer.concat(stderr).toString("utf8"),
    stdout: Buffer.concat(stdout).toString("utf8"),
  };
}

async function doesNotExist(target) {
  await assert.rejects(access(target), { code: "ENOENT" });
}

test("Pi Droid KVM capability is proven in Actions before label promotion or release", async (t) => {
  const [helper, capabilityWorkflow, releaseWorkflow, documentation] = await Promise.all([
    source("android/build-logic/prove-kvm-runner-capability.sh"),
    source(".github/workflows/android-kvm-capability.yml"),
    source(".github/workflows/android-internal.yml"),
    source("docs/pi-droid-kvm-runner.md"),
  ]);

  assert.match(helper, /GITHUB_ACTIONS:-.*!= 'true'/);
  assert.match(helper, /device="\$\{PI_DROID_KVM_DEVICE:-\/dev\/kvm\}"/);
  assert.match(helper, /\[\[ ! -c "\$device" \]\]/);
  assert.match(helper, /\[\[ ! -r "\$device" \|\| ! -w "\$device" \]\]/);
  assert.match(helper, /os\.open\(device, os\.O_RDWR \| os\.O_CLOEXEC\)/);
  assert.match(helper, /KVM_GET_API_VERSION = 0xAE00/);
  assert.match(helper, /EXPECTED_KVM_API_VERSION = 12/);
  assert.match(helper, /"readyForLabel": True/);
  assert.match(helper, /receipt_parent\.relative_to\(runner_temp\)/);
  assert.match(helper, /os\.chmod\(temporary, 0o600\)/);
  assert.match(helper, /os\.replace\(temporary, receipt\)/);
  assert.match(helper, /android_kvm_ready=true/);
  assert.doesNotMatch(helper, /env(?:iron)?\b.*(?:dump|items|environ)/i);
  assert.doesNotMatch(helper, /chmod\s+(?:666|777)|sudo/);

  assert.match(
    capabilityWorkflow,
    /runs-on: \[self-hosted, nix, x86_64-linux, android-kvm-candidate\]/,
  );
  assert.match(capabilityWorkflow, /name: Open KVM and record capability receipt/);
  assert.match(capabilityWorkflow, /prove-kvm-runner-capability\.sh/);
  assert.match(capabilityWorkflow, /steps\.kvm\.outputs\.android_kvm_ready/);
  assert.match(capabilityWorkflow, /Review the receipt before replacing `android-kvm-candidate` with `android-kvm`/);
  assert.match(capabilityWorkflow, /actions\/upload-artifact@v6/);
  assert.doesNotMatch(capabilityWorkflow, /google-play-internal|PI_DROID_RELEASE_|PI_DROID_GOOGLE_PLAY/);

  assert.match(releaseWorkflow, /runs-on: \[self-hosted, nix, x86_64-linux, android-kvm\]/);
  const proof = releaseWorkflow.indexOf("name: Verify labeled runner KVM capability");
  const secrets = releaseWorkflow.indexOf("name: Materialize Play release secrets");
  const build = releaseWorkflow.indexOf("name: Build, verify, and screenshot signed AAB");
  assert.ok(proof >= 0 && proof < secrets && secrets < build);
  assert.match(releaseWorkflow.slice(proof, secrets), /prove-kvm-runner-capability\.sh/);
  assert.match(releaseWorkflow, /pi-droid-release\/kvm-capability\.json/);
  assert.doesNotMatch(releaseWorkflow, /run: test -r \/dev\/kvm -a -w \/dev\/kvm/);

  assert.match(documentation, /android-kvm-candidate.*temporary routing only/s);
  assert.match(documentation, /Add it only after.*Actions-executed proof succeeds/s);
  assert.match(documentation, /Do not.*recurring `chmod`/s);
  assert.match(documentation, /31558756854/);
  assert.match(documentation, /31560683515/);
  assert.match(documentation, /31560935109/);

  await t.test("non-Actions execution cannot mint a receipt", async () => {
    const fixture = await runHelper({ GITHUB_ACTIONS: "false" });
    try {
      assert.equal(fixture.status, 78);
      assert.match(fixture.stderr, /must run inside a GitHub Actions job/);
      assert.equal(await readFile(fixture.output, "utf8"), "");
      await doesNotExist(fixture.receipt);
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("an absent job-context device fails closed without outputs", async () => {
    const fixture = await runHelper({
      PI_DROID_KVM_DEVICE: "/definitely-not-present/pi-droid-kvm",
      PI_DROID_KVM_TEST_FIXTURE: "1",
    });
    try {
      assert.equal(fixture.status, 69);
      assert.match(fixture.stderr, /KVM device is absent in Runner\.Worker context/);
      assert.equal(await readFile(fixture.output, "utf8"), "");
      await doesNotExist(fixture.receipt);
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("a regular file cannot masquerade as KVM", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "pi-droid-fake-kvm-"));
    const fakeDevice = path.join(fixtureRoot, "kvm");
    await writeFile(fakeDevice, "not a device", { mode: 0o600 });
    const fixture = await runHelper({
      PI_DROID_KVM_DEVICE: fakeDevice,
      PI_DROID_KVM_TEST_FIXTURE: "1",
    });
    try {
      assert.equal(fixture.status, 65);
      assert.match(fixture.stderr, /not a character device/);
      assert.equal(await readFile(fixture.output, "utf8"), "");
      await doesNotExist(fixture.receipt);
    } finally {
      await fixture.cleanup();
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
