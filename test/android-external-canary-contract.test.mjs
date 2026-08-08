import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureToken = "0123456789abcdef".repeat(4);

async function source(relative) {
  return readFile(path.join(root, relative), "utf8");
}

function runProcess(command, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
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

async function privateDirectory(parent, name) {
  const directory = path.join(parent, name);
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
}

async function withFixtureServer(block) {
  const fixtures = {
    capabilities: (await source("fixtures/session-api/capabilities.response.json")).replaceAll("host-01", "host-fixture-01"),
    inventory: await source("fixtures/session-api/dashboard.inventory.response.json"),
    information: await source("fixtures/session-api/dashboard.info.response.json"),
    transcript: await source("fixtures/session-api/dashboard.transcript.response.json"),
    runningInventory: await source("fixtures/android/external-canary-inventory-running.json"),
    runningInformation: await source("fixtures/android/external-canary-info-running.json"),
  };
  const requests = [];
  let running = false;
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    if (request.headers.authorization !== `Bearer ${fixtureToken}`) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end('{"ok":false}');
      return;
    }
    const pathname = new URL(request.url, "http://fixture.invalid").pathname;
    let body;
    if (pathname === "/v1/capabilities") body = fixtures.capabilities;
    else if (pathname === "/v1/dashboard/inventory") body = running ? fixtures.runningInventory : fixtures.inventory;
    else if (pathname.endsWith("/transcript")) body = fixtures.transcript;
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
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("external canary surface is debug-only, content-free, fenced, and mutation-free", async () => {
  const [
    harness,
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
  assert.match(harness, /run-as "\$package_name" sh -c[\s\S]*cat > no_backup\/external-canary-import\.json/);
  assert.match(harness, /< "\$staging_file" > \/dev\/null/);
  assert.doesNotMatch(harness, /am start[^\n]*-d|pidroid:\/\/pair\/v1\/|cat "\$token_file"/);
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
  assert.doesNotMatch(screen.slice(screen.indexOf("private fun ExternalCanaryScreen"), screen.indexOf("public fun HostRegistrationScreen")), /Button\(|SessionSurface\(|RichInteractiveSessionSurface\(/);
  assert.match(debugManifest, /ALLOW_EXTERNAL_CANARY_IMPORT/);
  assert.doesNotMatch(mainManifest, /ALLOW_EXTERNAL_CANARY_IMPORT/);
  assert.match(mainManifest, /android:allowBackup="false"/);
  assert.match(mainManifest, /android:fullBackupContent="false"/);
});

test("preflight uses only bounded authenticated GETs and emits a content-free fenced import", async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "pi-droid-external-canary-test-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await chmod(sandbox, 0o700);
  const tokenFile = path.join(sandbox, "api-token");
  await writeFile(tokenFile, `${fixtureToken}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const helper = path.join(root, "android/build-logic/external-canary-preflight.py");

  await withFixtureServer(async ({ origin, requests, setRunning }) => {
    async function invoke(name) {
      const privateDir = await privateDirectory(sandbox, `${name}-private`);
      const artifactsDir = await privateDirectory(sandbox, `${name}-artifacts`);
      const stagingFile = path.join(privateDir, "import.json");
      const receiptFile = path.join(artifactsDir, "preflight.json");
      const result = await runProcess("python3", [
        helper,
        "--api-url", origin,
        "--token-file", tokenFile,
        "--staging-file", stagingFile,
        "--receipt-file", receiptFile,
        "--allow-insecure-http",
      ]);
      return { result, stagingFile, receiptFile };
    }

    const safe = await invoke("safe");
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

    setRunning(true);
    const beforeRunning = requests.length;
    const running = await invoke("running");
    assert.equal(JSON.parse(await readFile(running.receiptFile, "utf8")).observerAttachAllowed, false);
    assert.equal(JSON.parse(await readFile(running.stagingFile, "utf8")).observerAttachAllowed, false);
    assert.equal(requests.length - beforeRunning, 4);

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
  await writeFile(path.join(patternRoot, "log.bin"), Buffer.from("Authorization: Bearer definitely-not-the-exact-token"));
  await assert.rejects(
    runProcess("python3", [scanner, "--token-file", tokenFile, "--root", patternRoot]),
    (error) => {
      assert.equal(error.code, 65);
      assert.match(error.stdout, /reason=structured_pattern/);
      assert.doesNotMatch(error.stdout, /definitely-not-the-exact-token/);
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
