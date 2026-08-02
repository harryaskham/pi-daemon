import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileServiceWatchdogStore,
  NativeSupervisorRecovery,
  ServiceWatchdog,
  semanticHttpProbe,
} from "../dist/service-watchdog.js";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server) {
  await new Promise((resolve) => server.close(() => resolve()));
}

class MemoryStore {
  state;
  saves = [];

  async load() {
    return this.state === undefined ? undefined : structuredClone(this.state);
  }

  async save(state) {
    this.state = structuredClone(state);
    this.saves.push(structuredClone(state));
  }
}

const commandOk = { exitCode: 0, signal: null, timedOut: false };

test("semantic probes distinguish TCP accept with no HTTP bytes, degraded latency, and health", async (t) => {
  const muteSockets = new Set();
  const mute = createNetServer((socket) => {
    muteSockets.add(socket);
    socket.once("close", () => muteSockets.delete(socket));
  });
  const mutePort = await listen(mute);
  t.after(async () => {
    for (const socket of muteSockets) socket.destroy();
    await close(mute);
  });
  const timedOut = await semanticHttpProbe(
    { component: "api", url: `http://127.0.0.1:${mutePort}/`, expectedStatus: 401 },
    40,
    20,
  );
  assert.equal(timedOut.phase, "failed");
  assert.equal(timedOut.errorCode, "timeout");

  let delayMs = 35;
  const semantic = createHttpServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(401, { Connection: "close" });
      response.end();
    }, delayMs);
  });
  const port = await listen(semantic);
  t.after(() => close(semantic));
  const degraded = await semanticHttpProbe(
    { component: "api", url: `http://127.0.0.1:${port}/`, expectedStatus: 401 },
    200,
    10,
  );
  assert.equal(degraded.phase, "degraded");
  assert.equal(degraded.statusCode, 401);
  assert.ok(degraded.latencyMs >= 10);

  delayMs = 0;
  const healthy = await semanticHttpProbe(
    { component: "api", url: `http://127.0.0.1:${port}/`, expectedStatus: 401 },
    200,
    100,
  );
  assert.equal(healthy.phase, "healthy");
  assert.equal(healthy.statusCode, 401);
});

test("watchdog state is atomic, owner-private, bounded, and identity checked", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-watchdog-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "nested", "watchdog-v1.json");
  const store = new FileServiceWatchdogStore(path);
  const state = {
    schemaVersion: 1,
    instance: "alpha",
    phase: "healthy",
    updatedAt: "2026-08-02T12:00:00.000Z",
    components: {
      api: {
        consecutiveFailures: 0,
        recoveryAttempted: false,
        lastProbe: { component: "api", phase: "healthy", latencyMs: 1, statusCode: 401 },
      },
    },
  };
  await store.save(state);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await store.load("alpha"), state);
  await assert.rejects(store.load("beta"), /identity is invalid/);
  await chmod(path, 0o644);
  await assert.rejects(store.load("alpha"), /must be owner-only/);
});

test("degraded API latency is recorded without duplicate web load or recovery", async () => {
  const store = new MemoryStore();
  const calls = [];
  const watchdog = new ServiceWatchdog({
    instance: "alpha",
    api: { component: "api", url: "http://127.0.0.1:17463/", expectedStatus: 401 },
    web: { component: "web", url: "http://127.0.0.1:17465/dash/readyz", expectedStatus: 204 },
    store,
    recovery: {
      supervisor: "systemd",
      async recover(component) {
        calls.push(["recover", component]);
        return { ok: true, supervisor: "systemd", escalated: false, durationMs: 1 };
      },
    },
    probeTimeoutMs: 100,
    degradedAfterMs: 50,
    failureThreshold: 2,
    probe: async (target) => {
      calls.push(["probe", target.component]);
      return { component: target.component, phase: "degraded", latencyMs: 75, statusCode: target.expectedStatus };
    },
  });
  const state = await watchdog.cycle();
  assert.equal(state.phase, "degraded");
  assert.equal(state.components.api.consecutiveFailures, 0);
  assert.equal(state.components.api.recoveryAttempted, false);
  assert.equal(state.components.web.lastProbe.phase, "blocked");
  assert.deepEqual(calls, [["probe", "api"]]);
});

test("watchdog skips dependent web load, recovers once per failure epoch, and latches degraded", async () => {
  const store = new MemoryStore();
  const probes = {
    api: ["failed", "failed", "failed", "healthy", "failed", "failed"],
    web: ["healthy"],
  };
  const probeCalls = [];
  const recoveryCalls = [];
  const watchdog = new ServiceWatchdog({
    instance: "alpha",
    api: { component: "api", url: "http://127.0.0.1:17463/", expectedStatus: 401 },
    web: { component: "web", url: "http://127.0.0.1:17465/dash/readyz", expectedStatus: 204 },
    store,
    recovery: {
      supervisor: "systemd",
      async recover(component) {
        recoveryCalls.push(component);
        return { ok: true, supervisor: "systemd", escalated: false, durationMs: 1 };
      },
    },
    probeTimeoutMs: 100,
    degradedAfterMs: 50,
    failureThreshold: 2,
    probe: async (target) => {
      probeCalls.push(target.component);
      const phase = probes[target.component].shift();
      assert.ok(phase);
      return {
        component: target.component,
        phase,
        latencyMs: phase === "healthy" ? 1 : 100,
        ...(phase === "healthy" ? { statusCode: target.expectedStatus } : { errorCode: "timeout" }),
      };
    },
  });

  let state = await watchdog.cycle();
  assert.equal(state.components.api.consecutiveFailures, 1);
  assert.equal(state.components.web.lastProbe.phase, "blocked");
  assert.deepEqual(recoveryCalls, []);

  state = await watchdog.cycle();
  assert.equal(state.phase, "degraded");
  assert.equal(state.components.api.recoveryAttempted, true);
  assert.deepEqual(recoveryCalls, ["api"]);
  assert.ok(store.saves.some((saved) => saved.phase === "recovering"));

  await watchdog.cycle();
  assert.deepEqual(recoveryCalls, ["api"], "a persistent failure must not restart-loop");

  state = await watchdog.cycle();
  assert.equal(state.phase, "healthy");
  assert.equal(state.components.api.recoveryAttempted, false);
  assert.equal(state.components.web.lastProbe.phase, "healthy");

  await watchdog.cycle();
  state = await watchdog.cycle();
  assert.deepEqual(recoveryCalls, ["api", "api"], "a semantic success starts a new failure epoch");
  assert.equal(state.components.api.recoveryAttempted, true);
  assert.deepEqual(probeCalls, ["api", "api", "api", "api", "web", "api", "api"]);
});

test("native recovery targets only the exact systemd instance", async () => {
  const commands = [];
  const recovery = new NativeSupervisorRecovery({
    instance: "alpha",
    supervisor: "systemd",
    gracefulTimeoutMs: 30_000,
    commandRunner: async (executable, args, timeoutMs) => {
      commands.push({ executable, args: [...args], timeoutMs });
      return commandOk;
    },
  });
  const result = await recovery.recover("web", async () => {
    throw new Error("systemd owns graceful readiness polling");
  });
  assert.equal(result.ok, true);
  assert.equal(result.escalated, false);
  assert.deepEqual(commands, [{
    executable: "systemctl",
    args: ["--user", "restart", "pi-daemon-web-alpha.service"],
    timeoutMs: 40_000,
  }]);
});

test("launchd recovery preserves a slow new PID after graceful drain", async (t) => {
  if (process.getuid === undefined) {
    t.skip("launchd domains require a numeric uid");
    return;
  }
  const commands = [];
  let printCount = 0;
  const recovery = new NativeSupervisorRecovery({
    instance: "alpha",
    supervisor: "launchd",
    gracefulTimeoutMs: 50,
    commandTimeoutMs: 100,
    pollIntervalMs: 1,
    commandRunner: async (executable, args, timeoutMs) => {
      commands.push({ executable, args: [...args], timeoutMs });
      if (args[0] === "print") {
        printCount += 1;
        return { ...commandOk, stdout: `pid = ${printCount === 1 ? 123 : 456}\n` };
      }
      return commandOk;
    },
  });
  const result = await recovery.recover("api", async () => ({
    component: "api",
    phase: "failed",
    latencyMs: 1,
    errorCode: "timeout",
  }));
  const target = `gui/${process.getuid()}/com.pi-daemon.alpha`;
  assert.equal(result.ok, true);
  assert.equal(result.escalated, false);
  assert.deepEqual(commands, [
    { executable: "launchctl", args: ["print", target], timeoutMs: 100 },
    { executable: "launchctl", args: ["kill", "SIGTERM", target], timeoutMs: 100 },
    { executable: "launchctl", args: ["print", target], timeoutMs: 100 },
  ]);
});

test("launchd recovery gives the same stuck PID a bounded chance, then audits exact-label escalation", async (t) => {
  if (process.getuid === undefined) {
    t.skip("launchd domains require a numeric uid");
    return;
  }
  const commands = [];
  const recovery = new NativeSupervisorRecovery({
    instance: "alpha",
    supervisor: "launchd",
    gracefulTimeoutMs: 5,
    commandTimeoutMs: 50,
    pollIntervalMs: 1,
    commandRunner: async (executable, args, timeoutMs) => {
      commands.push({ executable, args: [...args], timeoutMs });
      return args[0] === "print" ? { ...commandOk, stdout: "pid = 123\n" } : commandOk;
    },
  });
  const result = await recovery.recover("web", async () => ({
    component: "web",
    phase: "failed",
    latencyMs: 1,
    errorCode: "timeout",
  }));
  const target = `gui/${process.getuid()}/com.pi-daemon.web.alpha`;
  assert.equal(result.ok, true);
  assert.equal(result.escalated, true);
  assert.deepEqual(commands[0], {
    executable: "launchctl",
    args: ["print", target],
    timeoutMs: 50,
  });
  assert.deepEqual(commands[1], {
    executable: "launchctl",
    args: ["kill", "SIGTERM", target],
    timeoutMs: 50,
  });
  assert.deepEqual(commands.at(-1), {
    executable: "launchctl",
    args: ["kickstart", "-k", target],
    timeoutMs: 50,
  });
  assert.ok(commands.slice(2, -1).every((command) =>
    command.executable === "launchctl" &&
    command.args[0] === "print" &&
    command.args[1] === target
  ));
});
