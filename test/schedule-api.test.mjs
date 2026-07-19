import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ServiceBearerAuthenticator } from "../dist/api-auth.js";
import { ApiServer } from "../dist/api-server.js";
import { importConfiguredSchedules } from "../dist/schedule-config.js";
import { FileScheduleStore } from "../dist/schedule-store.js";
import { Multiplexer } from "../dist/multiplexer.js";
import { FileSessionCatalog } from "../dist/session-catalog.js";
import { SessionApiClient, SessionApiClientError } from "../dist/session-client.js";

const TOKEN = "schedule-api-fixture-token-0123456789";
class EmptyFactory { async open() { throw new Error("not used"); } }

async function harness(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-schedule-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = new FileSessionCatalog({ stateDir: root });
  await catalog.recover();
  await catalog.create({ sessionId: "session-01", name: "daily", generation: 1, residency: "dormant", state: "idle", spec: { cwd: root, target: { mode: "new" }, isolation: { mode: "unisolated" } } });
  const multiplexer = new Multiplexer({ factory: new EmptyFactory(), catalog, hostInstanceId: "host-schedules" });
  await multiplexer.recover();
  const store = new FileScheduleStore({ stateDir: root });
  const server = new ApiServer({ multiplexer, schedules: store, ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }), authenticator: new ServiceBearerAuthenticator(TOKEN), host: "::1", port: 0 });
  const address = await server.start();
  t.after(async () => { await server.stop(); await multiplexer.dispose(100); });
  return { root, store, multiplexer, address, client: new SessionApiClient({ baseUrl: `http://[${address.host}]:${address.port}`, bearerToken: TOKEN }) };
}

const definition = { sessionRef: "daily", enabled: true, cron: "0 9 * * 1-5", timezone: "UTC", prompt: "private prompt sentinel", overlapPolicy: "skip", missedWakePolicy: { mode: "skip" }, jitterMs: 0, maxAdmissionDelayMs: 300000 };

test("schedule API authenticates before existence and enforces idempotency plus exact ETags", async (t) => {
  const h = await harness(t);
  const denied = await raw(h.address, "/v1/schedule/private-id");
  assert.equal(denied.status, 401);
  assert.equal(JSON.stringify(denied.value).includes("private-id"), false);

  const created = await h.client.createSchedule("weekday", definition, "create-key");
  assert.equal(created.status, 201);
  assert.equal(created.data.sessionRef, "session-01");
  assert.equal(created.data.revision, 0);
  assert.equal(typeof created.headers.etag, "string");
  const replay = await h.client.createSchedule("weekday", definition, "create-key");
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.data, created.data);
  await assert.rejects(h.client.createSchedule("weekday", { ...definition, cron: "1 9 * * 1-5" }, "create-key"), (error) => error instanceof SessionApiClientError && error.code === "idempotency_conflict");

  await assert.rejects(h.client.updateSchedule("weekday", { ...definition, enabled: false }, '"stale:0"', "update-stale"), (error) => error instanceof SessionApiClientError && error.status === 412);
  const updated = await h.client.setScheduleEnabled("weekday", false, created.headers.etag, "disable-key");
  assert.equal(updated.data.revision, 1);
  assert.equal(updated.data.enabled, false);
  const competing = await Promise.allSettled([
    h.client.updateSchedule("weekday", { ...definition, enabled: false, cron: "1 9 * * 1-5" }, updated.headers.etag, "busy-a"),
    h.client.updateSchedule("weekday", { ...definition, enabled: false, cron: "2 9 * * 1-5" }, updated.headers.etag, "busy-b"),
  ]);
  assert.equal(competing.filter((value) => value.status === "fulfilled").length, 1);
  assert.equal(competing.filter((value) => value.status === "rejected" && value.reason instanceof SessionApiClientError && value.reason.status === 412).length, 1);
  const winner = competing.find((value) => value.status === "fulfilled").value;
  const listed = await h.client.listSchedules("daily");
  assert.deepEqual(listed.data.schedules.map((value) => value.scheduleId), ["weekday"]);
  const status = await h.client.scheduleStatus();
  assert.deepEqual(status.data, { timerRuntime: false, externalTimersSupported: true, scheduleCount: 1, enabledCount: 0 });
  await assert.rejects(h.client.createSchedule("malformed", { ...definition, cron: "not cron" }, "malformed-key"), (error) => error instanceof SessionApiClientError && error.code === "invalid_schedule");
  await assert.rejects(h.client.createSchedule("oversized", { ...definition, prompt: "x".repeat(65_537) }, "oversized-key"), (error) => error instanceof SessionApiClientError && error.status === 413);
  await h.client.deleteSchedule("weekday", winner.headers.etag, "delete-key");
  assert.deepEqual((await h.client.deleteSchedule("weekday", winner.headers.etag, "delete-key")).data, { deleted: true });
});

test("native timer capability and mutation recompute are authoritative", async (t) => {
  let recomputes = 0;
  const scheduler = {
    async recompute() { recomputes += 1; },
    status() { return { running: true, draining: false, activeAdmissions: 0, queuedOverlaps: 0, nextWakeAt: "2026-07-21T09:00:00.000Z" }; },
  };
  const h = await harness(t, { scheduler });
  const capabilities = await h.client.scheduleCapabilities();
  assert.equal(capabilities.data.timerRuntime, true);
  await h.client.createSchedule("native", definition, "native-create");
  assert.equal(recomputes, 1);
  assert.deepEqual((await h.client.scheduleStatus()).data, {
    timerRuntime: true,
    externalTimersSupported: true,
    scheduleCount: 1,
    enabledCount: 1,
    nextWakeAt: "2026-07-21T09:00:00.000Z",
  });
});

test("schedule config imports owner-private prompt references without exposing content", async (t) => {
  const h = await harness(t);
  const configPath = join(h.root, "config.yaml");
  const importPath = join(h.root, "daily.yaml");
  const promptPath = join(h.root, "prompt.txt");
  await writeFile(promptPath, "prompt from private file", { mode: 0o600 });
  await writeFile(importPath, `scheduleId: imported\nsessionRef: daily\ncron: "0 8 * * *"\npromptFile: prompt.txt\n`, { mode: 0o600 });
  await writeFile(configPath, "schedules: {}\n", { mode: 0o600 });
  await Promise.all([chmod(importPath, 0o600), chmod(configPath, 0o600)]);
  const loadedConfig = { path: configPath, config: { schedules: { defaults: { enabled: true, timezone: "UTC", overlapPolicy: "skip", missedWakePolicy: { mode: "skip" }, jitterMs: 0, maxAdmissionDelayMs: 1 }, imports: ["daily.yaml"] } }, resolvePath: (value) => join(h.root, value) };
  const result = await importConfiguredSchedules({ loadedConfig, store: h.store, resolveSession: async (ref) => (await h.multiplexer.retainedSession(ref))?.sessionId });
  assert.deepEqual(result, { imported: 1, created: 1, updated: 0, unchanged: 0 });
  assert.equal((await h.store.get("imported")).prompt, "prompt from private file");
});

function raw(address, path) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: address.host, port: address.port, path }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.once("error", reject); request.end();
  });
}
