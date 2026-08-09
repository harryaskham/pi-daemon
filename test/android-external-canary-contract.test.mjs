import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureToken = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("base64url");
const legacyFixtureToken = "Legacy-Token_09.~+/value==";

async function source(relative) {
  return readFile(path.join(root, relative), "utf8");
}

function runProcess(command, args, { input, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: env === undefined ? process.env : { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else reject(Object.assign(new Error(`process exited ${code ?? signal}`), result));
    });
    child.stdin.end(input);
  });
}

async function resolveBash() {
  if (process.env.BASH && path.isAbsolute(process.env.BASH)) return process.env.BASH;
  const result = await runProcess("bash", ["-c", 'printf %s "$BASH"']);
  const bash = result.stdout.trim();
  assert.ok(path.isAbsolute(bash), "resolved Bash must be an absolute path for a shebang");
  return bash;
}

async function privateDirectory(parent, name) {
  const directory = path.join(parent, name);
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
}

async function writePrivateToken(tokenFile, raw) {
  await writeFile(tokenFile, raw, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
}

async function invokePreflight(sandbox, name, origin, tokenFile) {
  const privateDir = await privateDirectory(sandbox, `${name}-private`);
  const artifactsDir = await privateDirectory(sandbox, `${name}-artifacts`);
  const stagingFile = path.join(privateDir, "import.json");
  const receiptFile = path.join(artifactsDir, "preflight.json");
  const result = await runProcess("python3", [
    path.join(root, "android/build-logic/external-canary-preflight.py"),
    "--api-url", origin,
    "--token-file", tokenFile,
    "--staging-file", stagingFile,
    "--receipt-file", receiptFile,
    "--allow-insecure-http",
  ]);
  return { result, stagingFile, receiptFile };
}

async function withFixtureServer(expectedToken, block) {
  const fixtures = {
    capabilities: (await source("fixtures/session-api/capabilities.response.json")).replaceAll("host-01", "host-fixture-01"),
    inventory: await source("fixtures/session-api/dashboard.inventory.response.json"),
    information: await source("fixtures/session-api/dashboard.info.response.json"),
    transcript: await source("fixtures/session-api/dashboard.transcript.response.json"),
    unavailableTranscript: await source("fixtures/session-api/dashboard.transcript.unavailable.response.json"),
    runningInventory: await source("fixtures/android/external-canary-inventory-running.json"),
    runningInformation: await source("fixtures/android/external-canary-info-running.json"),
  };
  const requests = [];
  let running = false;
  let transcriptUnavailable = false;
  let hostReady = true;
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    if (request.headers.authorization !== `Bearer ${expectedToken}`) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end('{"ok":false}');
      return;
    }
    const pathname = new URL(request.url, "http://fixture.invalid").pathname;
    let body;
    if (pathname === "/v1/capabilities") {
      const capabilities = JSON.parse(fixtures.capabilities);
      capabilities.data.host.ready = hostReady;
      body = JSON.stringify(capabilities);
    } else if (pathname === "/v1/dashboard/inventory") body = running ? fixtures.runningInventory : fixtures.inventory;
    else if (pathname.endsWith("/transcript")) {
      body = transcriptUnavailable ? fixtures.unavailableTranscript : fixtures.transcript;
    }
    else if (pathname === "/v1/dashboard/inventory/inventory-fixture-01") {
      body = running ? fixtures.runningInformation : fixtures.information;
    }
    if (body === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await block({
      origin: `http://127.0.0.1:${address.port}`,
      requests,
      setRunning(value) { running = value; },
      setTranscriptUnavailable(value) { transcriptUnavailable = value; },
      setHostReady(value) { hostReady = value; },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("external canary surface is debug-only, content-free, fenced, and mutation-free", async () => {
  const [
    harness,
    stagingHelper,
    receiptParser,
    preflight,
    scanner,
    activity,
    importer,
    repository,
    screen,
    debugManifest,
    mainManifest,
  ] = await Promise.all([
    source("android/build-logic/external-canary-proof.sh"),
    source("android/build-logic/external-canary-adb-staging.sh"),
    source("android/build-logic/external-canary-receipt.sh"),
    source("android/build-logic/external-canary-preflight.py"),
    source("android/build-logic/external-canary-secret-scan.py"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/MainActivity.kt"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/ExternalCanaryImport.kt"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/live/LiveReadonlyRepository.kt"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/live/LiveReadonlyScreen.kt"),
    source("android/app/src/debug/AndroidManifest.xml"),
    source("android/app/src/main/AndroidManifest.xml"),
  ]);

  assert.match(harness, /--api-url URL --token-file FILE --artifacts DIR/);
  assert.match(harness, /--allow-insecure-http/);
  assert.match(harness, /external-canary-preflight\.py/);
  assert.match(harness, /external-canary-receipt\.sh/);
  assert.doesNotMatch(harness, /\bjq\b/);
  assert.doesNotMatch(receiptParser, /\bjq\b/);
  assert.match(receiptParser, /EXTERNAL_CANARY_PYTHON_BIN:-python3/);
  assert.match(receiptParser, /type\(observer_attach_allowed\) is not bool/);
  assert.match(harness, /case "\$observer_attach_allowed" in[\s\S]*true\)[\s\S]*OBSERVER · ATTACHED TO IDLE SESSION[\s\S]*false\)[\s\S]*OBSERVER · NOT REQUESTED/);
  assert.match(harness, /stage_external_canary_import[\s\S]*"\$artifacts_dir" 30/);
  assert.ok(harness.indexOf("stage_external_canary_import") < harness.indexOf("shell am start -W"));
  assert.match(stagingHelper, /shell -T[\s\S]*run-as "\$package_name" sh -c/);
  assert.match(stagingHelper, /timeout --signal=TERM --kill-after=2s "\$\{deadline_seconds\}s"/);
  assert.match(stagingHelper, /cat > no_backup\/external-canary-import\.json/);
  assert.match(stagingHelper, /< "\$staging_file" > \/dev\/null[\s\S]*\} 2> \/dev\/null/);
  assert.match(stagingHelper, /stat -c "\\%a:\\%s"|stat -c "%a:%s"/);
  assert.match(stagingHelper, /sha256sum no_backup\/external-canary-import\.json/);
  assert.match(stagingHelper, /adb_staging_timeout/);
  assert.doesNotMatch(`${harness}\n${stagingHelper}`, /am start[^\n]*-d|pidroid:\/\/pair\/v1\/|cat "\$token_file"/);
  assert.doesNotMatch(harness, /start_daemon|stop_daemon|pi-droid-disposable-daemon|prompt|request_control/i);
  assert.match(harness, /run_external_canary_device_scan[\s\S]*stop_physical_proof_owned_processes[\s\S]*verify_external_canary_cleanup[\s\S]*run_external_canary_evidence_scan/);
  assert.match(harness, /residual_processes=0 residual_ports=0/);
  assert.match(harness, /external-canary-readonly\.png/);
  assert.match(harness, /external-canary-sha256sums\.txt/);
  assert.match(preflight, /method="GET"/);
  assert.doesNotMatch(preflight, /method="(?:POST|PUT|PATCH|DELETE)"/);
  assert.match(preflight, /class NoRedirect/);
  assert.match(preflight, /ProxyHandler\(\{\}\)/);
  assert.match(preflight, /O_NOFOLLOW/);
  assert.match(preflight, /info\.st_uid != os\.geteuid\(\)/);
  assert.match(scanner, /structured_pattern/);
  assert.match(scanner, /if token in data/);
  assert.match(activity, /registerExternalCanary/);
  assert.match(importer, /noBackupFilesDir/);
  assert.match(importer, /Files\.deleteIfExists\(path\)/);
  assert.match(repository, /external_canary_host_changed/);
  assert.match(repository, /external_canary_session_changed/);
  assert.match(repository, /external_canary_session_unsafe/);
  assert.match(repository, /observerEligible/);
  assert.match(screen, /EXTERNAL CANARY · READONLY/);
  assert.match(screen, /READONLY HYDRATION · VERIFIED/);
  assert.match(screen, /MUTATION SURFACE · ABSENT/);
  const canaryStart = screen.indexOf("private fun ExternalCanaryScreen");
  const canaryEnd = screen.indexOf("internal fun liveInteractiveStatusLabel", canaryStart);
  assert.ok(canaryStart >= 0 && canaryEnd > canaryStart, "external canary source boundary must remain explicit");
  const canarySurface = screen.slice(canaryStart, canaryEnd);
  assert.doesNotMatch(canarySurface, /Button\(|SessionSurface\(|RichInteractiveSessionSurface\(/);
  assert.match(debugManifest, /ALLOW_EXTERNAL_CANARY_IMPORT/);
  assert.doesNotMatch(mainManifest, /ALLOW_EXTERNAL_CANARY_IMPORT/);
  assert.match(mainManifest, /android:allowBackup="false"/);
  assert.match(mainManifest, /android:fullBackupContent="false"/);
});

test("owner-private ADB staging is exact, bounded, redacted, and leaves ambient ADB authority alone", async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "pi-droid-external-staging-test-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await chmod(sandbox, 0o700);
  const bash = await resolveBash();
  const fakeBin = await privateDirectory(sandbox, "bin");
  const fakeAdb = path.join(fakeBin, "adb");
  await writeFile(fakeAdb, `#!${bash}
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_ADB_LOG"
if [[ "$1" != '-H' || "$2" != '127.0.0.1' || "$3" != '-P' || "$4" != '42001' ]]; then
  exit 92
fi
if [[ " $* " == *' shell am start '* ]]; then
  : > "$FAKE_APP_LAUNCH_MARKER"
  exit 0
fi
if [[ " $* " == *'cat > no_backup/external-canary-import.json'* ]]; then
  case "$FAKE_ADB_MODE" in
    success|verification-mismatch)
      cat > "$FAKE_DEVICE_FILE"
      chmod 600 "$FAKE_DEVICE_FILE"
      exit 0
      ;;
    hang-after-eof)
      cat > "$FAKE_DEVICE_FILE"
      chmod 600 "$FAKE_DEVICE_FILE"
      trap '' TERM
      while :; do sleep 60; done
      ;;
    early-failure)
      exit 23
      ;;
  esac
fi
if [[ " $* " == *' sha256sum no_backup/external-canary-import.json '* ]]; then
  if [[ "$FAKE_ADB_MODE" == 'verification-mismatch' ]]; then
    printf '644:%s\\n' "$(stat -c '%s' "$FAKE_DEVICE_FILE")"
  else
    stat -c '%a:%s' "$FAKE_DEVICE_FILE"
  fi
  digest="$(sha256sum "$FAKE_DEVICE_FILE")"
  printf '%s\\n' "$digest"
  exit 0
fi
exit 93
`, { mode: 0o700 });
  await chmod(fakeAdb, 0o700);

  const ambient = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    ambient.once("spawn", resolve);
    ambient.once("error", reject);
  });
  t.after(() => {
    if (ambient.pid !== undefined) {
      try { process.kill(ambient.pid, "SIGKILL"); } catch {}
    }
  });

  const driver = `
set -euo pipefail
source "$1"
staging_file="$2"
artifacts_dir="$3"
isolated_adb_command=(adb -H 127.0.0.1 -P 42001)
cleanup_fixture() {
  rm -f "$FAKE_DEVICE_FILE"
  : > "$CLEANUP_MARKER"
}
trap cleanup_fixture EXIT
stage_external_canary_import \\
  '127.0.0.1:5567' 'com.harryaskham.pidroid.debug' \\
  "$staging_file" "$artifacts_dir" 1
"\${isolated_adb_command[@]}" -s '127.0.0.1:5567' shell am start \\
  -n 'com.harryaskham.pidroid.debug/com.harryaskham.pidroid.MainActivity' >/dev/null
`;

  for (const fixture of [
    { name: "success", mode: "success", code: 0, receiptCode: "verified", launches: true },
    { name: "hanging-stdin-eof", mode: "hang-after-eof", code: 70, receiptCode: "adb_staging_timeout", launches: false },
    { name: "early-adb-failure", mode: "early-failure", code: 70, receiptCode: "adb_staging_failed", launches: false },
    { name: "verification-mismatch", mode: "verification-mismatch", code: 70, receiptCode: "adb_staging_verification_failed", launches: false },
  ]) {
    const fixtureRoot = await privateDirectory(sandbox, fixture.name);
    const artifacts = await privateDirectory(fixtureRoot, "artifacts");
    const stagingFile = path.join(fixtureRoot, "external-canary-import.json");
    const deviceFile = path.join(fixtureRoot, "device-import.json");
    const adbLog = path.join(fixtureRoot, "adb.log");
    const cleanupMarker = path.join(fixtureRoot, "cleanup-invoked");
    const appLaunchMarker = path.join(fixtureRoot, "app-launched");
    const payload = `${JSON.stringify({ schemaVersion: 1, pairingEnvelope: `pidroid://pair/v1/${fixtureToken}` })}\n`;
    await writeFile(stagingFile, payload, { mode: 0o600 });
    await chmod(stagingFile, 0o600);
    const environment = {
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      FAKE_ADB_MODE: fixture.mode,
      FAKE_ADB_LOG: adbLog,
      FAKE_DEVICE_FILE: deviceFile,
      CLEANUP_MARKER: cleanupMarker,
      FAKE_APP_LAUNCH_MARKER: appLaunchMarker,
    };
    if (fixture.code === 0) {
      const result = await runProcess(bash, [
        "-c", driver, "external-canary-staging-fixture",
        path.join(root, "android/build-logic/external-canary-adb-staging.sh"),
        stagingFile,
        artifacts,
      ], { env: environment });
      assert.equal(result.stdout, "", fixture.name);
      assert.equal(result.stderr, "", fixture.name);
    } else {
      await assert.rejects(
        runProcess(bash, [
          "-c", driver, "external-canary-staging-fixture",
          path.join(root, "android/build-logic/external-canary-adb-staging.sh"),
          stagingFile,
          artifacts,
        ], { env: environment }),
        (error) => {
          assert.equal(error.code, fixture.code, fixture.name);
          assert.equal(error.stdout, "", fixture.name);
          assert.equal(
            error.stderr,
            `external_canary_staging_failed code=${fixture.receiptCode}\n`,
            fixture.name,
          );
          return true;
        },
      );
    }

    const receiptFile = path.join(artifacts, "external-canary-staging.log");
    const receipt = await readFile(receiptFile, "utf8");
    const adbCalls = await readFile(adbLog, "utf8");
    assert.match(receipt, new RegExp(`code=${fixture.receiptCode}`), fixture.name);
    assert.match(receipt, /deadline_seconds=1 transport=adb_shell_v2_no_pty/, fixture.name);
    assert.equal((await stat(receiptFile)).mode & 0o777, 0o600, fixture.name);
    assert.doesNotMatch(`${receipt}${adbCalls}`, new RegExp(fixtureToken), fixture.name);
    assert.ok(adbCalls.split("\\n").filter(Boolean).every((line) => line.startsWith("-H 127.0.0.1 -P 42001 ")), fixture.name);
    assert.doesNotMatch(adbCalls, /(?:^|[^0-9])5037(?:[^0-9]|$)|kill-server|reconnect/, fixture.name);
    assert.equal(await readFile(cleanupMarker, "utf8"), "", fixture.name);
    await assert.rejects(stat(deviceFile), { code: "ENOENT" });
    if (fixture.launches) {
      assert.equal(await readFile(appLaunchMarker, "utf8"), "", fixture.name);
      assert.match(adbCalls, /shell -T run-as com\.harryaskham\.pidroid\.debug sh -c/);
      assert.match(receipt, /status=staged code=verified mode=600 bytes=[1-9][0-9]* exact_bytes=true/);
    } else {
      await assert.rejects(stat(appLaunchMarker), { code: "ENOENT" });
      assert.match(receipt, /status=failed .*app_launch=false/);
    }
    assert.ok(ambient.pid !== undefined);
    assert.doesNotThrow(() => process.kill(ambient.pid, 0), `${fixture.name} must not terminate an ambient process`);
  }
});

test("external canary receipt parser accepts only present JSON booleans", async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "pi-droid-external-receipt-test-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await chmod(sandbox, 0o700);
  const parser = path.join(root, "android/build-logic/external-canary-receipt.sh");
  const fixtures = JSON.parse(await source("test/fixtures/android-external-canary-observer-eligibility.json"));
  const expectedError = "external canary preflight receipt observerAttachAllowed must be a JSON boolean\n";

  for (const fixture of fixtures.cases) {
    const receiptFile = path.join(sandbox, `${fixture.name}.json`);
    await writeFile(receiptFile, `${JSON.stringify(fixture.receipt)}\n`, { mode: 0o600 });
    const invocation = [
      "-c",
      'source "$1"; parse_external_canary_observer_attach_allowed "$2"',
      "external-canary-receipt-test",
      parser,
      receiptFile,
    ];
    if (fixture.expected !== undefined) {
      const result = await runProcess("bash", invocation);
      assert.equal(result.stdout, `${fixture.expected}\n`, fixture.name);
      assert.equal(result.stderr, "", fixture.name);
    } else {
      await assert.rejects(
        runProcess("bash", invocation),
        (error) => {
          assert.equal(error.code, fixture.expectedExit, fixture.name);
          assert.equal(error.stdout, "", fixture.name);
          assert.equal(error.stderr, expectedError, fixture.name);
          return true;
        },
      );
    }
  }
});

test("preflight uses only bounded authenticated GETs and emits a content-free fenced import", async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "pi-droid-external-canary-test-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await chmod(sandbox, 0o700);
  const tokenFile = path.join(sandbox, "api-token");
  await writePrivateToken(tokenFile, `${fixtureToken}\n`);
  const helper = path.join(root, "android/build-logic/external-canary-preflight.py");

  await withFixtureServer(fixtureToken, async ({
    origin,
    requests,
    setRunning,
    setTranscriptUnavailable,
    setHostReady,
  }) => {
    const safe = await invokePreflight(sandbox, "safe", origin, tokenFile);
    assert.equal(safe.result.stdout, "");
    assert.equal(safe.result.stderr, "");
    assert.equal(requests.length, 4);
    assert.deepEqual(requests.map(({ method }) => method), ["GET", "GET", "GET", "GET"]);
    assert.deepEqual(requests.map(({ url }) => url), [
      "/v1/capabilities",
      "/v1/dashboard/inventory?limit=50",
      "/v1/dashboard/inventory/inventory-fixture-01",
      "/v1/dashboard/inventory/inventory-fixture-01/transcript?limit=50",
    ]);
    assert.ok(requests.every(({ authorization }) => authorization === `Bearer ${fixtureToken}`));

    const receiptText = await readFile(safe.receiptFile, "utf8");
    const receipt = JSON.parse(receiptText);
    assert.equal(receipt.observerAttachAllowed, true);
    assert.equal(receipt.hostReady, true);
    assert.deepEqual(receipt.methods, ["GET"]);
    assert.equal(receipt.capabilities, true);
    assert.equal(receipt.inventory, true);
    assert.equal(receipt.information, true);
    assert.equal(receipt.transcript, true);
    assert.doesNotMatch(receiptText, /Contract fixture|Show the contract|0123456789abcdef/);

    const staging = JSON.parse(await readFile(safe.stagingFile, "utf8"));
    assert.equal(staging.expectedHostInstanceId, "host-fixture-01");
    assert.equal(staging.expectedInventoryId, "inventory-fixture-01");
    assert.equal(staging.observerAttachAllowed, true);
    const payloadText = staging.pairingEnvelope.slice("pidroid://pair/v1/".length);
    const payload = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8"));
    assert.equal(payload.apiUrl, origin);
    assert.equal(payload.bearer, fixtureToken);
    assert.equal((await stat(safe.stagingFile)).mode & 0o777, 0o600);
    assert.equal((await stat(safe.receiptFile)).mode & 0o777, 0o600);

    setTranscriptUnavailable(true);
    const beforeUnavailable = requests.length;
    const unavailable = await invokePreflight(sandbox, "unavailable", origin, tokenFile);
    assert.equal(JSON.parse(await readFile(unavailable.receiptFile, "utf8")).observerAttachAllowed, false);
    assert.equal(JSON.parse(await readFile(unavailable.stagingFile, "utf8")).observerAttachAllowed, false);
    assert.equal(requests.length - beforeUnavailable, 4);

    setTranscriptUnavailable(false);
    setRunning(true);
    const beforeRunning = requests.length;
    const running = await invokePreflight(sandbox, "running", origin, tokenFile);
    assert.equal(JSON.parse(await readFile(running.receiptFile, "utf8")).observerAttachAllowed, false);
    assert.equal(JSON.parse(await readFile(running.stagingFile, "utf8")).observerAttachAllowed, false);
    assert.equal(requests.length - beforeRunning, 4);

    setHostReady(false);
    const beforeNotReady = requests.length;
    await assert.rejects(
      invokePreflight(sandbox, "not-ready", origin, tokenFile),
      (error) => {
        assert.equal(error.code, 70);
        assert.equal(error.stdout, "");
        assert.equal(error.stderr, "external_canary_preflight_failed code=host_not_ready\n");
        return true;
      },
    );
    assert.equal(requests.length - beforeNotReady, 1, "readiness must gate inventory and transcript GETs");

    await chmod(tokenFile, 0o644);
    const invalidPrivate = await privateDirectory(sandbox, "invalid-private");
    const invalidArtifacts = await privateDirectory(sandbox, "invalid-artifacts");
    await assert.rejects(
      runProcess("python3", [
        helper,
        "--api-url", origin,
        "--token-file", tokenFile,
        "--staging-file", path.join(invalidPrivate, "import.json"),
        "--receipt-file", path.join(invalidArtifacts, "preflight.json"),
        "--allow-insecure-http",
      ]),
      (error) => {
        assert.equal(error.code, 70);
        assert.match(error.stderr, /code=token_file_not_owner_only/);
        assert.doesNotMatch(`${error.stdout}${error.stderr}`, new RegExp(fixtureToken));
        return true;
      },
    );
  });
});

test("missing local Node dependencies consume no authenticated or device budget", async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "pi-droid-external-dependency-test-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await chmod(sandbox, 0o700);
  const bash = await resolveBash();

  await withFixtureServer(fixtureToken, async ({ origin, requests }) => {
    for (const fixture of [
      { name: "missing-node-modules", validToken: true },
      { name: "missing-tsc", validToken: false },
    ]) {
      const fixtureRoot = await privateDirectory(sandbox, fixture.name);
      const repository = await privateDirectory(fixtureRoot, "repository");
      await mkdir(path.join(repository, "android"), { mode: 0o700 });
      await cp(
        path.join(root, "android/build-logic"),
        path.join(repository, "android/build-logic"),
        { recursive: true },
      );
      await cp(path.join(root, "package.json"), path.join(repository, "package.json"));
      await cp(path.join(root, "package-lock.json"), path.join(repository, "package-lock.json"));
      if (fixture.name === "missing-tsc") {
        await mkdir(path.join(repository, "node_modules/.bin"), { recursive: true, mode: 0o700 });
      }

      const gradleMarker = path.join(fixtureRoot, "gradle-started");
      const emulatorMarker = path.join(fixtureRoot, "emulator-started");
      await writeFile(
        path.join(repository, "android/gradlew"),
        `#!${bash}\n: > "$GRADLE_MARKER"\nexit 97\n`,
        { mode: 0o700 },
      );
      const fakeBin = await privateDirectory(fixtureRoot, "bin");
      const fakeEmulator = path.join(fakeBin, "emulator");
      await writeFile(fakeEmulator, `#!${bash}\n: > "$EMULATOR_MARKER"\nexit 98\n`, { mode: 0o700 });
      await chmod(fakeEmulator, 0o700);

      const tokenFile = path.join(fixtureRoot, "api-token");
      if (fixture.validToken) await writePrivateToken(tokenFile, `${fixtureToken}\n`);
      const artifacts = path.join(fixtureRoot, "artifacts");
      const requestsBefore = requests.length;
      await assert.rejects(
        runProcess("bash", [
          path.join(repository, "android/build-logic/external-canary-proof.sh"),
          "--api-url", origin,
          "--token-file", tokenFile,
          "--artifacts", artifacts,
          "--allow-insecure-http",
        ], {
          env: {
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
            GRADLE_MARKER: gradleMarker,
            EMULATOR_MARKER: emulatorMarker,
          },
        }),
        (error) => {
          assert.equal(error.code, 70, fixture.name);
          assert.equal(error.stdout, "", fixture.name);
          assert.equal(
            error.stderr,
            "external_canary_local_preflight_failed code=node_dependencies_unavailable remedy=npm_ci_ignore_scripts\n",
            fixture.name,
          );
          assert.doesNotMatch(`${error.stdout}${error.stderr}`, new RegExp(fixtureToken), fixture.name);
          return true;
        },
      );
      assert.equal(requests.length, requestsBefore, `${fixture.name} must perform zero GETs`);
      await assert.rejects(stat(gradleMarker), { code: "ENOENT" });
      await assert.rejects(stat(emulatorMarker), { code: "ENOENT" });
      await assert.rejects(stat(artifacts), { code: "ENOENT" });
    }
  });
});

test("false observer eligibility reaches the next bounded harness phase", async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "pi-droid-external-false-path-test-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await chmod(sandbox, 0o700);
  const tokenFile = path.join(sandbox, "api-token");
  const artifacts = path.join(sandbox, "artifacts");
  const fakeBin = await privateDirectory(sandbox, "bin");
  const fakeNpm = path.join(fakeBin, "npm");
  const bash = await resolveBash();
  await writePrivateToken(tokenFile, `${fixtureToken}\n`);
  await writeFile(
    fakeNpm,
    `#!${bash}\nif [[ "\${1:-}" == 'ls' ]]; then exit 0; fi\nprintf '%s\\n' 'phase=node-build boundary=entered'\nexit 23\n`,
    { mode: 0o700 },
  );
  await chmod(fakeNpm, 0o700);

  await withFixtureServer(fixtureToken, async ({ origin, requests, setTranscriptUnavailable }) => {
    setTranscriptUnavailable(true);
    await assert.rejects(
      runProcess("bash", [
        path.join(root, "android/build-logic/external-canary-proof.sh"),
        "--api-url", origin,
        "--token-file", tokenFile,
        "--artifacts", artifacts,
        "--allow-insecure-http",
      ], { env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}` } }),
      (error) => {
        assert.equal(error.code, 23);
        assert.equal(error.stdout, "");
        assert.equal(error.stderr, "");
        return true;
      },
    );
    assert.equal(requests.length, 4);
    assert.deepEqual(requests.map(({ method }) => method), ["GET", "GET", "GET", "GET"]);
    assert.ok(requests.every(({ authorization }) => authorization === `Bearer ${fixtureToken}`));
  });

  const receipt = JSON.parse(await readFile(path.join(artifacts, "external-canary-preflight.json"), "utf8"));
  const nodeBuild = await readFile(path.join(artifacts, "node-build.log"), "utf8");
  const evidenceScan = await readFile(path.join(artifacts, "external-canary-evidence-scan.log"), "utf8");
  const appScan = await readFile(path.join(artifacts, "external-canary-app-data-scan.log"), "utf8");
  const cleanup = await readFile(path.join(artifacts, "external-canary-cleanup.log"), "utf8");
  assert.equal(receipt.observerAttachAllowed, false);
  assert.equal(nodeBuild, "phase=node-build boundary=entered\n");
  assert.match(evidenceScan, /^status=clean scan=retained_artifacts /);
  assert.match(appScan, /^status=not_installed scan=app_private_stream /);
  assert.equal(cleanup, "status=clean residual_processes=0 residual_ports=0 adb_server=stopped emulator=stopped\n");
  assert.doesNotMatch(`${nodeBuild}${evidenceScan}${appScan}${cleanup}`, new RegExp(fixtureToken));
  await assert.rejects(stat(path.join(artifacts, "android-build.log")), { code: "ENOENT" });
});

test("external canary token readers share the canonical bounded Bearer contract", async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "pi-droid-external-token-test-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await chmod(sandbox, 0o700);
  const scanner = path.join(root, "android/build-logic/external-canary-secret-scan.py");
  const cleanRoot = await privateDirectory(sandbox, "clean");
  await writeFile(path.join(cleanRoot, "proof.log"), "content-free proof\n");

  assert.equal(fixtureToken.length, 43);
  assert.match(fixtureToken, /^[A-Za-z0-9_-]{43}$/);
  const accepted = [
    { name: "canonical-base64url", token: fixtureToken, lineEnding: "\n" },
    { name: "legacy-safe", token: legacyFixtureToken, lineEnding: "" },
    { name: "minimum", token: "A".repeat(16), lineEnding: "\n" },
    { name: "maximum-crlf", token: "z".repeat(4096), lineEnding: "\r\n" },
  ];
  for (const { name, token, lineEnding } of accepted) {
    const tokenFile = path.join(sandbox, `${name}.token`);
    await writePrivateToken(tokenFile, `${token}${lineEnding}`);
    await withFixtureServer(token, async ({ origin, requests }) => {
      const preflight = await invokePreflight(sandbox, name, origin, tokenFile);
      assert.equal(preflight.result.stdout, "");
      assert.equal(preflight.result.stderr, "");
      assert.equal(requests.length, 4);
      assert.ok(requests.every(({ authorization }) => authorization === `Bearer ${token}`));
    });
    const scan = await runProcess("python3", [scanner, "--token-file", tokenFile, "--root", cleanRoot]);
    assert.match(scan.stdout, /^status=clean scan=retained_artifacts /);
    assert.equal(scan.stderr, "");
  }
});

test("external canary token readers reject bounds, whitespace, controls, unsafe characters, and invalid UTF-8", async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "pi-droid-external-token-reject-test-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await chmod(sandbox, 0o700);
  const tokenFile = path.join(sandbox, "api-token");
  const scanner = path.join(root, "android/build-logic/external-canary-secret-scan.py");
  const cleanRoot = await privateDirectory(sandbox, "clean");
  const invalid = [
    { name: "too-short", raw: Buffer.from(`${"a".repeat(15)}\n`), code: "token_file_format_invalid" },
    { name: "too-long", raw: Buffer.from(`${"a".repeat(4097)}\n`), code: "token_file_format_invalid" },
    { name: "whitespace", raw: Buffer.from("contains whitespace 123456\n"), code: "token_file_format_invalid" },
    { name: "control", raw: Buffer.concat([Buffer.from("control-token-123456"), Buffer.from([0x7f, 0x0a])]), code: "token_file_format_invalid" },
    { name: "unsafe", raw: Buffer.from("unsafe:token-value-123456\n"), code: "token_file_format_invalid" },
    { name: "invalid-utf8", raw: Buffer.concat([Buffer.from("invalid-token-123456"), Buffer.from([0xff, 0x0a])]), code: "token_file_format_invalid" },
    { name: "extra-line-ending", raw: Buffer.from(`${legacyFixtureToken}\n\n`), code: "token_file_format_invalid" },
    { name: "raw-too-large", raw: Buffer.from("a".repeat(4099)), code: "token_file_size_invalid" },
  ];

  await withFixtureServer(fixtureToken, async ({ origin, requests }) => {
    for (const { name, raw, code } of invalid) {
      await writePrivateToken(tokenFile, raw);
      await assert.rejects(
        invokePreflight(sandbox, `reject-${name}`, origin, tokenFile),
        (error) => {
          assert.equal(error.code, 70);
          assert.equal(error.stdout, "");
          assert.equal(error.stderr, `external_canary_preflight_failed code=${code}\n`);
          return true;
        },
      );
      await assert.rejects(
        runProcess("python3", [scanner, "--token-file", tokenFile, "--root", cleanRoot]),
        (error) => {
          assert.equal(error.code, 70);
          assert.equal(error.stdout, "status=scan_failed scan=unknown scanned_files=0 scanned_bytes=0 reason=token_invalid\n");
          assert.equal(error.stderr, "");
          return true;
        },
      );
    }
    assert.equal(requests.length, 0);
  });
});

test("early preflight failure still scans retained evidence with a canonical live-format token", async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "pi-droid-external-early-scan-test-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await chmod(sandbox, 0o700);
  const tokenFile = path.join(sandbox, "api-token");
  const artifacts = path.join(sandbox, "artifacts");
  await writePrivateToken(tokenFile, `${fixtureToken}\n`);

  await withFixtureServer(legacyFixtureToken, async ({ origin, requests }) => {
    await assert.rejects(
      runProcess("bash", [
        path.join(root, "android/build-logic/external-canary-proof.sh"),
        "--api-url", origin,
        "--token-file", tokenFile,
        "--artifacts", artifacts,
        "--allow-insecure-http",
      ]),
      (error) => {
        assert.equal(error.code, 70);
        assert.doesNotMatch(`${error.stdout}${error.stderr}`, new RegExp(fixtureToken));
        return true;
      },
    );
    assert.equal(requests.length, 1);
  });

  const evidenceScan = await readFile(path.join(artifacts, "external-canary-evidence-scan.log"), "utf8");
  const appScan = await readFile(path.join(artifacts, "external-canary-app-data-scan.log"), "utf8");
  const cleanup = await readFile(path.join(artifacts, "external-canary-cleanup.log"), "utf8");
  assert.match(evidenceScan, /^status=clean scan=retained_artifacts /);
  assert.match(appScan, /^status=not_installed scan=app_private_stream /);
  assert.equal(cleanup, "status=clean residual_processes=0 residual_ports=0 adb_server=stopped emulator=stopped\n");
  assert.doesNotMatch(`${evidenceScan}${appScan}${cleanup}`, new RegExp(fixtureToken));
  await assert.rejects(stat(path.join(artifacts, "node-build.log")), { code: "ENOENT" });
});

test("external canary scanner checks binary artifacts and streamed app-private data without echoing secrets", async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "pi-droid-external-scan-test-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await chmod(sandbox, 0o700);
  const tokenFile = path.join(sandbox, "api-token");
  await writeFile(tokenFile, `${fixtureToken}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const scanner = path.join(root, "android/build-logic/external-canary-secret-scan.py");

  const cleanRoot = await privateDirectory(sandbox, "clean");
  await writeFile(path.join(cleanRoot, "screenshot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
  await writeFile(path.join(cleanRoot, "proof.log"), "readonly proof\n");
  const clean = await runProcess("python3", [scanner, "--token-file", tokenFile, "--root", cleanRoot]);
  assert.match(clean.stdout, /^status=clean scan=retained_artifacts /);

  const exactRoot = await privateDirectory(sandbox, "exact");
  await writeFile(path.join(exactRoot, "binary.png"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(fixtureToken), Buffer.from([3])]));
  await assert.rejects(
    runProcess("python3", [scanner, "--token-file", tokenFile, "--root", exactRoot]),
    (error) => {
      assert.equal(error.code, 65);
      assert.match(error.stdout, /reason=exact/);
      assert.doesNotMatch(error.stdout, new RegExp(fixtureToken));
      return true;
    },
  );

  const patternRoot = await privateDirectory(sandbox, "pattern");
  await writeFile(path.join(patternRoot, "log.bin"), Buffer.from("Authorization: Bearer ++++++++////////=="));
  await assert.rejects(
    runProcess("python3", [scanner, "--token-file", tokenFile, "--root", patternRoot]),
    (error) => {
      assert.equal(error.code, 65);
      assert.match(error.stdout, /reason=structured_pattern/);
      assert.doesNotMatch(error.stdout, /\+{8}|\/{8}/);
      return true;
    },
  );

  const streamed = await runProcess(
    "python3",
    [scanner, "--token-file", tokenFile, "--stream"],
    { input: Buffer.from("bounded encrypted app-private archive") },
  );
  assert.match(streamed.stdout, /^status=clean scan=app_private_stream /);
  assert.doesNotMatch(`${streamed.stdout}${streamed.stderr}`, new RegExp(fixtureToken));
});
