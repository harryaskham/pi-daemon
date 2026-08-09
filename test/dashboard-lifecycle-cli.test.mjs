import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/cli.js";
import { assertCliExitCode } from "./cli-exit-diagnostics.mjs";

class EmptyFactory {
  opens = 0;
  async open() {
    this.opens += 1;
    throw new Error("fixture runtime open rejected");
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test("serve CLI can enable the embedded Dashboard when YAML omits web", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pd-web-cli-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const webPort = await freePort();
  const work = join(root, "work");
  const configDir = join(root, "config");
  await Promise.all([
    mkdir(work, { recursive: true, mode: 0o700 }),
    mkdir(configDir, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(join(configDir, "auth.json"), "{}\n", { mode: 0o600 });
  const configPath = join(configDir, "config.yaml");
  await writeFile(configPath, `instance: embedded-cli-test
stateDir: ../state
socketPath: ../run/pi-daemon.sock
agentDir: ../agent
authSeedFile: ./auth.json
allowedRoots: [../work]
`, { mode: 0o600 });

  const logs = [];
  let fetched = false;
  let callbackError;
  const code = await runCli(
    [
      "serve",
      "--config",
      configPath,
      "--instance",
      "embedded-cli-test",
      "--web-enabled",
      "true",
      "--web-bind",
      "127.0.0.1",
      "--web-port",
      String(webPort),
    ],
    { stdout: () => {}, stderr: (line) => logs.push(line) },
    {
      factory: new EmptyFactory(),
      waitForShutdown: async (shutdown) => {
        try {
          const response = await fetch(`http://127.0.0.1:${webPort}/dash/`);
          assert.equal(response.status, 200);
          fetched = true;
        } catch (error) {
          callbackError = error;
        } finally {
          await shutdown(500);
        }
      },
    },
  );
  assertCliExitCode(code, 0, logs, "serve CLI embedded dashboard");
  if (callbackError !== undefined) throw callbackError;
  assert.equal(fetched, true);

  // Omitting every web option preserves the historical socket-only behavior
  // when YAML omits `web`.
  const omittedLogs = [];
  const omittedCode = await runCli(
    ["serve", "--config", configPath, "--instance", "embedded-cli-test"],
    { stdout: () => {}, stderr: (line) => omittedLogs.push(line) },
    {
      factory: new EmptyFactory(),
      waitForShutdown: async (shutdown) => shutdown(500),
    },
  );
  assertCliExitCode(omittedCode, 0, omittedLogs, "serve CLI web omission");
  assert.ok(omittedLogs.some((line) => JSON.parse(line).dashboard?.enabled === false));
});

test("serve --web-enabled false overrides enabling YAML", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pd-web-off-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const webPort = await freePort();
  const work = join(root, "work");
  const configDir = join(root, "config");
  await Promise.all([
    mkdir(work, { recursive: true, mode: 0o700 }),
    mkdir(configDir, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(join(configDir, "auth.json"), "{}\n", { mode: 0o600 });
  const configPath = join(configDir, "config.yaml");
  await writeFile(configPath, `instance: embedded-disable-test
stateDir: ../state
socketPath: ../run/pi-daemon.sock
agentDir: ../agent
authSeedFile: ./auth.json
allowedRoots: [../work]
web:
  enabled: true
  mode: embedded
  bind: 127.0.0.1
  port: ${webPort}
`, { mode: 0o600 });

  const logs = [];
  const code = await runCli(
    ["serve", "--config", configPath, "--instance", "embedded-disable-test", "--web-enabled", "false"],
    { stdout: () => {}, stderr: (line) => logs.push(line) },
    {
      factory: new EmptyFactory(),
      waitForShutdown: async (shutdown) => {
        await assert.rejects(fetch(`http://127.0.0.1:${webPort}/dash/`));
        await shutdown(500);
      },
    },
  );
  assertCliExitCode(code, 0, logs, "serve CLI disables embedded dashboard");
  assert.ok(logs.some((line) => JSON.parse(line).dashboard?.enabled === false));
});

test("serve rejects invalid embedded web CLI options before publishing listeners", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pd-web-bad-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const work = join(root, "work");
  const configDir = join(root, "config");
  await Promise.all([
    mkdir(work, { recursive: true, mode: 0o700 }),
    mkdir(configDir, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(join(configDir, "auth.json"), "{}\n", { mode: 0o600 });
  const configPath = join(configDir, "config.yaml");
  const socketPath = join(root, "run", "pi-daemon.sock");
  const writeConfig = async (webYaml = "") =>
    writeFile(configPath, `instance: embedded-invalid-test
stateDir: ../state
socketPath: ../run/pi-daemon.sock
agentDir: ../agent
authSeedFile: ./auth.json
allowedRoots: [../work]
${webYaml}`, { mode: 0o600 });
  const attempt = async (extraArgs) => {
    let admitted = false;
    const code = await runCli(
      ["serve", "--config", configPath, "--instance", "embedded-invalid-test", ...extraArgs],
      { stdout: () => {}, stderr: () => {} },
      {
        factory: new EmptyFactory(),
        waitForShutdown: async () => {
          admitted = true;
        },
      },
    );
    assert.notEqual(code, 0);
    assert.equal(admitted, false);
    await assert.rejects(stat(socketPath));
  };

  await writeConfig();
  await attempt(["--web-enabled", "true", "--web-port", "65536"]);
  await attempt(["--web-enabled", "true", "--web-bind", "0.0.0.0", "--web-port", "0"]);
  await writeConfig("web:\n  enabled: true\n  mode: dedicated\n");
  await attempt(["--web-enabled", "true"]);
});

test("serve reload preserves validated wildcard binds and emits a content-free advisory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pd-web-wildcard-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const work = join(root, "work");
  const configDir = join(root, "config");
  await Promise.all([
    mkdir(work, { recursive: true, mode: 0o700 }),
    mkdir(configDir, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(join(configDir, "auth.json"), "{}\n", { mode: 0o600 });
  const configPath = join(configDir, "config.yaml");

  const run = async (bind, publicOrigin) => {
    await writeFile(configPath, `instance: wildcard-reload-test
stateDir: ../state
socketPath: ../run/pi-daemon.sock
agentDir: ../agent
authSeedFile: ./auth.json
allowedRoots: [../work]
web:
  enabled: true
  mode: embedded
  bind: "${bind}"
  port: 0
  publicOrigin: "${publicOrigin}"
  allowInsecureHttp: true
`, { mode: 0o600 });
    const logs = [];
    const code = await runCli(
      ["serve", "--config", configPath, "--instance", "wildcard-reload-test"],
      { stdout: () => {}, stderr: (line) => logs.push(line) },
      {
        factory: new EmptyFactory(),
        waitForShutdown: async (shutdown) => shutdown(500),
      },
    );
    assertCliExitCode(code, 0, logs, `serve wildcard ${bind}`);
    const events = logs.map((line) => JSON.parse(line));
    const advisory = events.find((entry) => entry.event === "dashboard_insecure_http_exposure");
    assert.deepEqual(
      {
        level: advisory?.level,
        host: advisory?.host,
        origin: advisory?.origin,
        authenticationRequired: advisory?.authenticationRequired,
        operatorOptIn: advisory?.operatorOptIn,
      },
      {
        level: "warn",
        host: bind,
        origin: publicOrigin,
        authenticationRequired: true,
        operatorOptIn: "allowInsecureHttp",
      },
    );
    const ready = events.find((entry) => entry.event === "pi_daemon_ready");
    assert.equal(ready?.dashboard.host, bind);
    assert.equal(ready?.dashboard.origin, publicOrigin);
  };

  await run("0.0.0.0", "http://dash-v4.example.test");
  await run("::", "http://dash-v6.example.test");
});

test("serve starts and drains the packaged embedded Dashboard without exposing credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-embedded-dash-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const [apiPort, webPort] = await Promise.all([freePort(), freePort()]);
  assert.notEqual(apiPort, webPort);
  const work = join(root, "work");
  const configDir = join(root, "config");
  await Promise.all([
    mkdir(work, { recursive: true, mode: 0o700 }),
    mkdir(configDir, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(join(configDir, "auth.json"), "{}\n", { mode: 0o600 });
  const configPath = join(configDir, "config.yaml");
  await writeFile(configPath, `instance: embedded-test
stateDir: ../state
socketPath: ../run/pi-daemon.sock
agentDir: ../agent
authSeedFile: ./auth.json
allowedRoots: [../work]
api:
  enabled: true
  bind: 127.0.0.1
  port: ${apiPort}
web:
  enabled: false
  mode: embedded
  inventory:
    roots: []
`, { mode: 0o600 });

  const logs = [];
  const factory = new EmptyFactory();
  let index = "";
  let callbackError;
  const code = await runCli(
    [
      "serve",
      "--config",
      configPath,
      "--instance",
      "embedded-test",
      "--web-enabled",
      "true",
      "--web-bind",
      "127.0.0.1",
      "--web-port",
      String(webPort),
    ],
    { stdout: () => {}, stderr: (line) => logs.push(line) },
    {
      factory,
      waitForShutdown: async (shutdown) => {
        try {
          const origin = `http://127.0.0.1:${webPort}`;
        const indexResponse = await fetch(`${origin}/dash/`);
        index = await indexResponse.text();
        assert.equal(indexResponse.status, 200, index);
        assert.match(index, /<div id="root"><\/div>/);
        assert.match(indexResponse.headers.get("content-security-policy"), /default-src 'none'/);

        const apiTokenPath = join(root, "state", "api-token");
        const apiToken = (await readFile(apiTokenPath, "utf8")).trimEnd();
        assert.equal((await stat(apiTokenPath)).mode & 0o777, 0o600);
        const capabilitiesResponse = await fetch(
          `http://127.0.0.1:${apiPort}/v1/dashboard/capabilities`,
          { headers: { Authorization: `Bearer ${apiToken}` } },
        );
        assert.equal(capabilitiesResponse.status, 200);
        const capabilities = await capabilitiesResponse.json();
        assert.equal(capabilities.data.presentations.rich.available, true);
        assert.equal(capabilities.data.presentations.tui.available, false);
        assert.equal(capabilities.data.resources.sessionDrafts, true);

        const apiOrigin = `http://127.0.0.1:${apiPort}`;
        const draftCreate = await fetch(`${apiOrigin}/v1/dashboard/session-drafts`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
            "X-Request-ID": "draft-create-lifecycle",
            "Idempotency-Key": "draft-create-key-lifecycle",
          },
          body: JSON.stringify({
            requestId: "draft-create-lifecycle",
            idempotencyKey: "draft-create-key-lifecycle",
            draftId: "draft-lifecycle",
            spec: {
              cwd: work,
              persistence: "memory",
              tools: { mode: "none" },
              resources: {
                noExtensions: true,
                noSkills: true,
                noPromptTemplates: true,
                noThemes: true,
                noContextFiles: true,
                projectTrust: "deny",
              },
              isolation: { mode: "unisolated" },
            },
          }),
        });
        const draftCreateText = await draftCreate.text();
        assert.equal(draftCreate.status, 201, draftCreateText);
        const draftEtag = draftCreate.headers.get("etag");
        assert.ok(draftEtag);
        const draft = JSON.parse(draftCreateText);
        assert.equal(draft.data.state, "draft");
        assert.equal(factory.opens, 0, "draft CRUD must not open a runtime");

        const privateMessage = "private first-send lifecycle fixture";
        const draftSend = await fetch(
          `${apiOrigin}/v1/dashboard/session-drafts/${draft.data.draftId}/send`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiToken}`,
              "Content-Type": "application/json",
              "X-Request-ID": "draft-send-lifecycle",
              "Idempotency-Key": "draft-send-key-lifecycle",
              "If-Match": draftEtag,
            },
            body: JSON.stringify({
              requestId: "draft-send-lifecycle",
              idempotencyKey: "draft-send-key-lifecycle",
              expectedRevision: draft.data.revision,
              message: privateMessage,
            }),
          },
        );
        const draftSendText = await draftSend.text();
        assert.equal(draftSend.status, 202, draftSendText);
        const sendTicket = JSON.parse(draftSendText);
        let terminal = sendTicket.data;
        const draftDeadline = Date.now() + 10_000;
        while (
          !["failed", "succeeded", "indeterminate"].includes(terminal.state) &&
          Date.now() < draftDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          const response = await fetch(
            `${apiOrigin}/v1/dashboard/session-draft-send/${sendTicket.data.ticketId}`,
            { headers: { Authorization: `Bearer ${apiToken}` } },
          );
          assert.equal(response.status, 200);
          terminal = (await response.json()).data;
        }
        assert.equal(terminal.state, "failed");
        assert.equal(factory.opens, 1, "first send must attempt exactly one runtime");
        assert.equal(JSON.stringify(terminal).includes(privateMessage), false);

        const webTokenPath = join(root, "state", "web-token");
        const webToken = (await readFile(webTokenPath, "utf8")).trimEnd();
        assert.equal((await stat(webTokenPath)).mode & 0o777, 0o600);
        const login = await fetch(`${origin}/dash/v1/login`, {
          method: "POST",
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            "X-Request-ID": "embedded-login",
          },
          body: JSON.stringify({
            requestId: "embedded-login",
            clientId: "embedded-client",
            workspaceId: "embedded-workspace",
            credential: webToken,
          }),
        });
        assert.equal(login.status, 200);
        assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
        const loginBody = await login.text();
        assert.equal(loginBody.includes(webToken), false);
        assert.equal(index.includes(webToken), false);
        assert.equal(logs.join("").includes(webToken), false);
        assert.equal(logs.join("").includes(apiToken), false);

        const parsedLogs = logs.map((line) => JSON.parse(line));
        const ready = parsedLogs.find((entry) => entry.event === "pi_daemon_ready");
        const startupStages = parsedLogs
          .filter((entry) => entry.event === "pi_daemon_startup_stage")
          .map((entry) => `${entry.stage}:${entry.state}`);
        for (const stage of [
          "path_bootstrap",
          "session_recovery",
          "schedule_recovery",
          "dashboard_runtime",
          "control_listener",
          "api_listener",
          "dashboard_listener",
        ]) {
          assert.ok(startupStages.includes(`${stage}:started`), `${stage} must identify its start`);
          assert.ok(startupStages.includes(`${stage}:completed`), `${stage} must identify completion`);
        }
        assert.deepEqual(ready.dashboard, {
          enabled: true,
          host: "127.0.0.1",
          port: webPort,
          origin,
          inventory: ready.dashboard.inventory,
        });
          assert.equal(ready.dashboard.inventory.initialized, true);
          assert.equal(ready.configuration.webConfigured, true);
        } catch (error) {
          callbackError = error;
        } finally {
          await shutdown(2_000);
        }
      },
    },
  );
  assertCliExitCode(code, 0, logs, "serve embedded dashboard lifecycle");
  if (callbackError !== undefined) throw callbackError;
  await assert.rejects(fetch(`http://127.0.0.1:${webPort}/dash/`));
  await assert.rejects(fetch(`http://127.0.0.1:${apiPort}/v1/capabilities`));

  const blocker = createServer();
  t.after(async () => {
    if (blocker.listening) {
      await new Promise((resolve) => blocker.close(() => resolve()));
    }
  });
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen({ host: "127.0.0.1", port: webPort }, resolve);
  });
  let admitted = false;
  const collisionCode = await runCli(
    [
      "serve",
      "--config",
      configPath,
      "--instance",
      "embedded-test",
      "--web-enabled",
      "true",
      "--web-bind",
      "127.0.0.1",
      "--web-port",
      String(webPort),
    ],
    { stdout: () => {}, stderr: () => {} },
    {
      factory: new EmptyFactory(),
      waitForShutdown: async () => { admitted = true; },
    },
  );
  assert.equal(collisionCode, 1);
  assert.equal(admitted, false);
  await assert.rejects(fetch(`http://127.0.0.1:${apiPort}/v1/capabilities`));
  await new Promise((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
});
