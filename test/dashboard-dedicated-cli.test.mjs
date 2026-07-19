import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/cli.js";

const TOKEN = "dedicated-api-token-fixture-0123456789";

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test("dedicated web CLI authenticates remotely and serves only browser credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-dedicated-web-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const [apiPort, webPort] = await Promise.all([freePort(), freePort()]);
  const capabilityFixture = JSON.parse(
    await readFile(new URL("../fixtures/session-api/dashboard.capabilities.response.json", import.meta.url), "utf8"),
  );
  let authenticatedRequests = 0;
  const upstream = createHttpServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { code: "unauthorized", message: "unauthorized", retryable: false } }));
      return;
    }
    authenticatedRequests += 1;
    if (request.url !== "/v1/dashboard/capabilities") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { code: "not_found", message: "not found", retryable: false } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(capabilityFixture));
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen({ host: "127.0.0.1", port: apiPort }, resolve);
  });
  t.after(async () => {
    if (upstream.listening) await new Promise((resolve) => upstream.close(() => resolve()));
  });

  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const apiTokenPath = join(configDir, "api-token");
  await writeFile(apiTokenPath, `${TOKEN}\n`, { mode: 0o600 });
  const configPath = join(configDir, "config.yaml");
  await writeFile(configPath, `instance: dedicated-test
stateDir: ../daemon-state
allowedRoots: [../work]
api:
  bind: 127.0.0.1
  port: ${apiPort}
  tokenFile: ./api-token
web:
  enabled: true
  mode: dedicated
  bind: 127.0.0.1
  port: ${webPort}
`, { mode: 0o600 });

  const logs = [];
  const code = await runCli(
    ["web", "--config", configPath, "--instance", "dedicated-test"],
    { stdout: () => {}, stderr: (line) => logs.push(line) },
    {
      waitForShutdown: async (shutdown) => {
        const origin = `http://127.0.0.1:${webPort}`;
        const response = await fetch(`${origin}/dash/`);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /<div id="root"><\/div>/);
        const webTokenPath = join(root, "daemon-state", "dedicated-web", "web-token");
        const webToken = (await readFile(webTokenPath, "utf8")).trimEnd();
        assert.equal((await stat(webTokenPath)).mode & 0o777, 0o600);
        const login = await fetch(`${origin}/dash/v1/login`, {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: "dedicated-login",
            clientId: "dedicated-client",
            workspaceId: "dedicated-workspace",
            credential: webToken,
          }),
        });
        assert.equal(login.status, 200);
        assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
        assert.equal(logs.join("").includes(TOKEN), false);
        assert.equal(logs.join("").includes(webToken), false);
        const ready = logs.map((line) => JSON.parse(line)).find((entry) => entry.event === "pi_daemon_web_ready");
        assert.equal(ready.port, webPort);
        assert.equal(ready.remoteApiOrigin, `http://127.0.0.1:${apiPort}`);
        await shutdown(2_000);
      },
    },
  );
  assert.equal(code, 0, logs.join(""));
  assert.equal(authenticatedRequests, 1);
  await assert.rejects(fetch(`http://127.0.0.1:${webPort}/dash/`));
});
