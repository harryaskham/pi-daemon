import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ServiceBearerAuthenticator } from "../dist/api-auth.js";
import { ApiServer } from "../dist/api-server.js";
import { runCli } from "../dist/cli.js";
import { FileDurabilityStore } from "../dist/durability.js";
import { Multiplexer } from "../dist/multiplexer.js";
import { ProtocolServer } from "../dist/server.js";
import { SessionApiClient } from "../dist/session-client.js";
import { FileSessionCatalog } from "../dist/session-catalog.js";
import { FileMutationTicketStore, MutationTicketController } from "../dist/tickets.js";

const TOKEN = "fixture-service-bearer-0123456789";

class FakeController {
  listeners = new Set();
  calls = [];
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(value) {
    for (const listener of this.listeners) listener(value);
  }
  snapshot() {
    return { rpcState: { sessionId: "pi-cli", isStreaming: false }, leafId: "leaf-cli" };
  }
  cancelPendingUi() {}
  respondToExtensionUi() {
    return false;
  }
  async handle(command) {
    this.calls.push(command);
    const response = {
      type: "response",
      command: command.type,
      success: true,
      ...(command.id === undefined ? {} : { id: command.id }),
    };
    if (command.type === "get_state") {
      return { ...response, data: { sessionId: "pi-cli", isStreaming: false } };
    }
    if (command.type === "get_entries") {
      return { ...response, data: { entries: [], leafId: "leaf-cli" } };
    }
    if (command.type === "prompt") {
      queueMicrotask(() => this.emit({ type: "agent_settled" }));
    }
    return response;
  }
}

class FakeAdapter {
  constructor(request, controller) {
    this.request = request;
    this.controller = controller;
    this.controls = [];
  }
  identity() {
    return { sessionId: `pi-${this.request.sessionId}` };
  }
  async rpcController() {
    return this.controller;
  }
  async prompt(request) {
    request.onEvent({ event: "agentSettled" });
    return { text: `answer:${request.prompt}` };
  }
  async steer(message) {
    this.controls.push(["steer", message]);
  }
  async followUp(message) {
    this.controls.push(["followUp", message]);
  }
  async abort() {
    this.controls.push(["abort"]);
  }
  async dispose() {}
}

class FakeFactory {
  adapters = [];
  async open(request) {
    const adapter = new FakeAdapter(request, new FakeController());
    this.adapters.push(adapter);
    return adapter;
  }
}

async function harness(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-session-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const socketPath = join(root, "daemon.sock");
  const factory = new FakeFactory();
  const multiplexer = new Multiplexer({
    factory,
    durability: new FileDurabilityStore({ stateDir }),
    catalog: new FileSessionCatalog({ stateDir }),
    hostInstanceId: `host-${randomBytes(4).toString("hex")}`,
  });
  await multiplexer.recover();
  const protocol = new ProtocolServer({ socketPath, multiplexer });
  await protocol.start();
  let ticketStore = new FileMutationTicketStore({ stateDir });
  let indeterminateTicketId;
  if (options.indeterminateTicket) {
    const pending = await ticketStore.begin({
      method: "DELETE",
      canonicalTarget: "/v1/session/reconcile-fixture?retainArtifacts=true",
      idempotencyKey: "reconcile-key",
      command: {
        operation: "delete",
        requestId: "reconcile-request",
        sessionId: "reconcile-fixture",
        expectedGeneration: 1,
        expectedRevision: 1,
        retainArtifacts: true,
      },
    });
    await ticketStore.markRunning(pending.ticketId);
    indeterminateTicketId = pending.ticketId;
    // Recovery transitions a prior process's running record to indeterminate.
    ticketStore = new FileMutationTicketStore({ stateDir });
  }
  const tickets = new MutationTicketController(ticketStore);
  const api = new ApiServer({
    multiplexer,
    tickets,
    authenticator: new ServiceBearerAuthenticator(TOKEN),
    host: "::1",
    port: 0,
  });
  const address = await api.start();
  t.after(async () => {
    await api.stop();
    await protocol.stop();
    await multiplexer.dispose(1_000);
  });
  return {
    factory,
    multiplexer,
    socketPath,
    url: `http://[${address.host}]:${address.port}`,
    indeterminateTicketId,
  };
}

const runJson = async (args, dependencies = {}) => {
  const stdout = [];
  const stderr = [];
  const code = await runCli(
    args,
    { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    { environment: { PI_DAEMON_BEARER_TOKEN: TOKEN }, ...dependencies },
  );
  return {
    code,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    value: stdout.length === 0 ? undefined : JSON.parse(stdout.join("")),
  };
};

test("CLI help advertises high-level session, ticket, RPC, and ACP commands", async () => {
  const output = [];
  assert.equal(
    await runCli(["help"], { stdout: (text) => output.push(text), stderr: () => {} }),
    0,
  );
  const help = output.join("");
  for (const command of [
    "session list|show|create|update|delete",
    "ticket get|wait|reconcile",
    "rpc attach",
    "acp discover",
    "--allow-root PATH ...",
  ]) {
    assert.match(help, new RegExp(command.replace(/[|.]/g, "\\$&")));
  }
});

test("high-level authenticated CLI covers CRUD, tickets, prompt/control, and endpoint discovery", async (t) => {
  const host = await harness(t);
  const common = ["--url", host.url, "--timeout-ms", "5000"];
  const created = await runJson([
    "session",
    "create",
    ...common,
    "--session",
    "cli-session",
    "--cwd",
    "/work/cli-session",
    "--target",
    "memory",
    "--name",
    "first-name",
    "--idempotency-key",
    "create-key",
    "--wait",
    "true",
  ]);
  assert.equal(created.code, 0, created.stderr);
  assert.equal(created.value.data.state, "succeeded");
  const ticketId = created.value.data.ticketId;

  const waited = await runJson(["ticket", "wait", ...common, "--ticket", ticketId]);
  assert.equal(waited.value.data.state, "succeeded");
  const listed = await runJson(["session", "list", ...common]);
  assert.equal(listed.value.data.sessions[0].sessionId, "cli-session");
  const shown = await runJson(["session", "show", ...common, "--session", "first-name"]);
  assert.equal(shown.value.data.sessionId, "cli-session");

  const prompt = await runJson([
    "prompt",
    ...common,
    "--session",
    "first-name",
    "--generation",
    "1",
    "--message",
    "hello",
  ]);
  assert.equal(prompt.code, 0, prompt.stderr);
  assert.equal(prompt.value.data.response.command, "prompt");
  assert.ok(prompt.value.data.events.some((event) => event.type === "agent_settled"));

  const control = await runJson([
    "control",
    "steer",
    ...common,
    "--session",
    "first-name",
    "--generation",
    "1",
    "--message",
    "focus",
  ]);
  assert.equal(control.value.data.response.command, "steer");

  const rpc = await runJson(["rpc", "discover", ...common, "--session", "first-name"]);
  assert.equal(rpc.value.data.subprotocol, "pi-daemon-rpc.v1");
  assert.match(rpc.value.data.url, /^ws:\/\/\[::1\]/);
  assert.equal(JSON.stringify(rpc.value).includes(TOKEN), false);
  const acp = await runJson(["acp", "discover", ...common, "--session", "first-name"]);
  assert.equal(acp.value.data.subprotocol, "agent-client-protocol.v1");

  const current = shown.value.data;
  const updated = await runJson([
    "session",
    "update",
    ...common,
    "--session",
    "first-name",
    "--generation",
    String(current.generation),
    "--revision",
    String(current.revision),
    "--cwd",
    "/work/cli-session",
    "--target",
    "memory",
    "--name",
    "second-name",
    "--idempotency-key",
    "update-key",
    "--wait",
    "true",
  ]);
  assert.equal(updated.value.data.state, "succeeded");
  const second = await runJson(["session", "show", ...common, "--session", "second-name"]);
  const deleted = await runJson([
    "session",
    "delete",
    ...common,
    "--session",
    "second-name",
    "--generation",
    String(second.value.data.generation),
    "--revision",
    String(second.value.data.revision),
    "--idempotency-key",
    "delete-key",
    "--retain",
    "false",
    "--wait",
    "true",
  ]);
  assert.equal(deleted.value.data.state, "succeeded");
});

test("ticket wait reports indeterminate and explicit reconciliation exits successfully", async (t) => {
  const host = await harness(t, { indeterminateTicket: true });
  const common = ["--url", host.url, "--timeout-ms", "5000"];
  const waited = await runJson([
    "ticket",
    "wait",
    ...common,
    "--ticket",
    host.indeterminateTicketId,
  ]);
  assert.equal(waited.code, 75);
  assert.equal(waited.value.data.state, "indeterminate");
  const reconciled = await runJson([
    "ticket",
    "reconcile",
    ...common,
    "--ticket",
    host.indeterminateTicketId,
    "--state",
    "succeeded",
    "--pi-entry-ids",
    "entry-operator-confirmed",
  ]);
  assert.equal(reconciled.code, 0, reconciled.stderr);
  assert.equal(reconciled.value.data.state, "succeeded");
});

test("high-level Unix CLI covers compatible open/status/wake/control/close operations", async (t) => {
  const host = await harness(t);
  const target = ["--socket", host.socketPath, "--timeout-ms", "5000"];
  assert.equal(
    (
      await runJson([
        "session",
        "create",
        ...target,
        "--session",
        "unix-session",
        "--generation",
        "1",
        "--cwd",
        "/work/unix",
        "--target",
        "memory",
      ])
    ).code,
    0,
  );
  const shown = await runJson([
    "session",
    "show",
    ...target,
    "--session",
    "unix-session",
  ]);
  assert.equal(shown.value.data.sessionId, "unix-session");
  const prompt = await runJson([
    "prompt",
    ...target,
    "--session",
    "unix-session",
    "--generation",
    "1",
    "--message",
    "hello",
    "--idempotency-key",
    "unix-prompt",
  ]);
  assert.equal(prompt.code, 0, prompt.stderr);
  const aborted = await runJson([
    "control",
    "abort",
    ...target,
    "--session",
    "unix-session",
    "--generation",
    "1",
  ]);
  assert.equal(aborted.code, 0, aborted.stderr);
  const closed = await runJson([
    "session",
    "delete",
    ...target,
    "--session",
    "unix-session",
    "--generation",
    "1",
    "--retain",
    "true",
  ]);
  assert.equal(closed.code, 0, closed.stderr);
});

test("RPC attach delegates without accepting bearer values on argv", async () => {
  const calls = [];
  const result = await runJson(
    ["rpc", "attach", "--session", "named", "--token-file", "/private/token"],
    {
      runRpcCli: async (args, io) => {
        calls.push({ args, environment: io.environment });
        return 7;
      },
      rpcIo: {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        environment: { PI_DAEMON_BEARER_TOKEN: TOKEN },
      },
    },
  );
  assert.equal(result.code, 7);
  assert.deepEqual(calls[0].args, ["--session", "named", "--token-file", "/private/token"]);
  assert.equal(JSON.stringify(calls[0].args).includes(TOKEN), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes(TOKEN), false);
});

test("session API client refuses implicit remote plaintext and hides bearer state", () => {
  assert.throws(
    () => new SessionApiClient({ baseUrl: "http://example.com", bearerToken: TOKEN }),
    /explicit insecure opt-in/,
  );
  const client = new SessionApiClient({
    baseUrl: "http://127.0.0.1:7463",
    bearerToken: TOKEN,
  });
  assert.equal(JSON.stringify(client).includes(TOKEN), false);
});

test("CLI rejects permissive spec files before reading raw environment values", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-cli-spec-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "spec.json");
  await writeFile(
    file,
    JSON.stringify({ cwd: "/work", target: { mode: "memory" }, env: { SECRET: "value" } }),
    { mode: 0o644 },
  );
  await chmod(file, 0o644);
  const result = await runJson([
    "session",
    "create",
    "--socket",
    "/tmp/not-contacted.sock",
    "--session",
    "secure",
    "--spec-file",
    file,
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /owner-only bounded regular/);
  assert.equal(result.stderr.includes("value"), false);
});

test("CLI rejects raw env in argv specs and ambiguous targets before I/O", async () => {
  const raw = await runJson([
    "session",
    "create",
    "--url",
    "http://127.0.0.1:1",
    "--spec-json",
    JSON.stringify({ cwd: "/work", target: { mode: "memory" }, env: { SECRET: "value" } }),
  ]);
  assert.equal(raw.code, 2);
  assert.match(raw.stderr, /raw env values are refused/);
  const ambiguous = await runJson([
    "session",
    "show",
    "--socket",
    "/tmp/daemon.sock",
    "--url",
    "http://127.0.0.1:7463",
    "--session",
    "x",
  ]);
  assert.equal(ambiguous.code, 2);
});
