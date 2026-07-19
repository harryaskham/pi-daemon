import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/cli.js";

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
  enabled: true
  mode: embedded
  bind: 127.0.0.1
  port: ${webPort}
  inventory:
    roots: []
`, { mode: 0o600 });

  const logs = [];
  const factory = new EmptyFactory();
  let index = "";
  let callbackError;
  const code = await runCli(
    ["serve", "--config", configPath, "--instance", "embedded-test"],
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

        const apiToken = (await readFile(join(root, "state", "api-token"), "utf8")).trimEnd();
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

        const ready = logs.map((line) => JSON.parse(line)).find((entry) => entry.event === "pi_daemon_ready");
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
  assert.equal(code, 0, logs.join(""));
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
    ["serve", "--config", configPath, "--instance", "embedded-test"],
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
