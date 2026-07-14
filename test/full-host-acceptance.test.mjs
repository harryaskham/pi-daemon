import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

const TOKEN = "full-acceptance-service-bearer-0123456789";
const MODEL_PROVIDER = "acceptance";
const MODEL_ID = "fixture-model";

class WsInbox {
  constructor(socket) {
    this.socket = socket;
    this.values = [];
    this.waiters = [];
    socket.on("message", (data) => this.#deliver(JSON.parse(data.toString())));
    socket.on("close", () => this.#close());
  }
  send(value) {
    this.socket.send(JSON.stringify(value));
  }
  async next(predicate = () => true, timeoutMs = 10_000) {
    const index = this.values.findIndex(predicate);
    if (index >= 0) return this.values.splice(index, 1)[0];
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new Error("timed out waiting for WebSocket message"));
      }, timeoutMs);
      waiter.resolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.waiters.push(waiter);
    });
  }
  close() {
    this.socket.close();
  }
  #deliver(value) {
    const index = this.waiters.findIndex((waiter) => waiter.predicate(value));
    if (index < 0) this.values.push(value);
    else this.waiters.splice(index, 1)[0].resolve(value);
  }
  #close() {
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("WebSocket closed"));
  }
}

function mockModelServer() {
  let active = 0;
  let maxActive = 0;
  let requests = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString("utf8");
    requests += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    const text = body.includes("PROMPT_B") ? "B" : body.includes("PROMPT_A2") ? "A2" : "A";
    await new Promise((resolve) => setTimeout(resolve, 35));
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      Connection: "close",
    });
    const base = {
      id: `chatcmpl-${requests}`,
      object: "chat.completion.chunk",
      created: 1,
      model: MODEL_ID,
    };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } })}\n\n`);
    response.end("data: [DONE]\n\n");
    active -= 1;
  });
  return {
    server,
    get maxActive() {
      return maxActive;
    },
    get requests() {
      return requests;
    },
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "::1", resolve);
  });
  return server.address();
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function addressHost(address) {
  return address.host ?? address.address;
}

function apiBase(address) {
  return `http://[${addressHost(address)}]:${address.port}`;
}

async function requestJson(address, options) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: addressHost(address),
        port: address.port,
        family: 6,
        method: options.method ?? "GET",
        path: options.path,
        headers: options.headers,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            value: body === "" ? undefined : JSON.parse(body),
          }),
        );
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(JSON.stringify(options.body));
    request.end();
  });
}

async function readTree(root) {
  const values = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) values.push(...(await readTree(path)));
    else if (entry.isFile() && (await stat(path)).size < 2 * 1024 * 1024) {
      values.push(await readFile(path, "utf8"));
    }
  }
  return values.join("\n");
}

async function waitForTicket(address, ticketId) {
  const deadline = Date.now() + 15_000;
  while (true) {
    const response = await requestJson(address, {
      path: `/v1/ticket/${encodeURIComponent(ticketId)}`,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
    if (["succeeded", "failed", "indeterminate"].includes(response.value.data.state)) {
      return response.value.data;
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for ticket");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function submitSession(address, body, key) {
  const response = await requestJson(address, {
    method: "POST",
    path: "/v1/session?waitForTerminal=true",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      "X-Request-Id": body.requestId,
    },
    body,
  });
  assert.equal(response.status, 202, JSON.stringify(response.value));
  return response.value.data;
}

async function connectWs(WebSocket, address, sessionId, protocol, options = {}) {
  const route = protocol === "agent-client-protocol.v1" ? "apc" : "rpc";
  const params = new URLSearchParams();
  if (options.role !== undefined) params.set("role", options.role);
  if (options.cursor !== undefined) params.set("cursor", options.cursor);
  const suffix = params.size === 0 ? "" : `?${params}`;
  const url = `ws://[${addressHost(address)}]:${address.port}/v1/session/${encodeURIComponent(sessionId)}/${route}${suffix}`;
  const socket = new WebSocket(url, protocol, {
    headers: { Authorization: `Bearer ${options.token ?? TOKEN}` },
    handshakeTimeout: 5_000,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
  });
  const inbox = new WsInbox(socket);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return inbox;
}

async function rpcCommand(inbox, id, type, fields = {}) {
  inbox.send({ kind: "command", command: { id, type, ...fields } });
  return inbox.next((value) => value.kind === "response" && value.response?.id === id);
}

async function startHost(deps, options) {
  const factory = new deps.PiSessionFactory({
    stateDir: options.stateDir,
    agentDir: options.agentDir,
    allowedRoots: [options.workRoot],
  });
  const durability = new deps.FileDurabilityStore({ stateDir: options.stateDir });
  const catalog = new deps.FileSessionCatalog({ stateDir: options.stateDir });
  const multiplexer = new deps.Multiplexer({
    factory,
    durability,
    catalog,
    limits: { maxConcurrentTurns: 1 },
  });
  const recovery = await multiplexer.recover();
  const tickets = new deps.MutationTicketController(
    new deps.FileMutationTicketStore({ stateDir: options.stateDir }),
  );
  const api = new deps.ApiServer({
    multiplexer,
    authenticator: new deps.ServiceBearerAuthenticator(TOKEN),
    tickets,
    host: "::1",
    port: 0,
  });
  const address = await api.start();
  return {
    address,
    api,
    catalog,
    durability,
    multiplexer,
    recovery,
    tickets,
    async stop() {
      await api.stop();
      await multiplexer.dispose(2_000);
    },
  };
}

function sessionSpec(cwd, target, name, systemPrompt, env) {
  return {
    cwd,
    name,
    target,
    model: { provider: MODEL_PROVIDER, id: MODEL_ID, thinkingLevel: "off" },
    tools: { mode: "none" },
    resources: {
      noExtensions: false,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      projectTrust: "deny",
      systemPrompt,
    },
    settings: { retry: { enabled: false, maxRetries: 0 } },
    env,
    isolation: { mode: "unisolated" },
  };
}

test("full standalone host acceptance across CRUD, RPC, ACP, bridge, restart, and security", { timeout: 60_000 }, async (t) => {
  const calls = [];
  const originals = new Map();
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    const original = childProcess[name];
    if (typeof original !== "function") continue;
    originals.set(name, original);
    childProcess[name] = (...args) => {
      calls.push({ name, argc: args.length });
      throw new Error(`child process forbidden during full host acceptance: ${name}`);
    };
  }
  syncBuiltinESMExports();

  const root = await mkdtemp(join(tmpdir(), "pi-daemon-full-acceptance-"));
  const workRoot = join(root, "work");
  const workA = join(workRoot, "a");
  const workB = join(workRoot, "b");
  const outside = join(root, "outside");
  const stateDir = join(root, "state");
  const agentDir = join(root, "agent");
  const extensionDir = join(workB, ".pi", "extensions");
  const extensionMarker = join(root, "ambient-extension-loaded");
  await Promise.all([
    mkdir(workA, { recursive: true, mode: 0o700 }),
    mkdir(extensionDir, { recursive: true, mode: 0o700 }),
    mkdir(outside, { recursive: true, mode: 0o700 }),
    mkdir(stateDir, { recursive: true, mode: 0o700 }),
    mkdir(agentDir, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(
    join(extensionDir, "ambient.ts"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(extensionMarker)}, "loaded"); export default function () {}\n`,
  );

  const mock = mockModelServer();
  const mockAddress = await listen(mock.server);
  await writeFile(
    join(agentDir, "models.json"),
    `${JSON.stringify({
      providers: {
        [MODEL_PROVIDER]: {
          baseUrl: `${apiBase(mockAddress)}/v1`,
          api: "openai-completions",
          apiKey: "acceptance-model-key",
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [
            {
              id: MODEL_ID,
              name: "Acceptance Fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 16384,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    })}\n`,
    { mode: 0o600 },
  );

  let firstHost;
  let secondHost;
  try {
    const [
      { default: WebSocket },
      { ApiServer },
      { ServiceBearerAuthenticator },
      { FileDurabilityStore, wakeTicketId },
      { Multiplexer },
      { PiSessionFactory },
      { FileSessionCatalog },
      { FileMutationTicketStore, MutationTicketController },
      { RpcStdioBridge },
    ] = await Promise.all([
      import("ws"),
      import("../dist/api-server.js"),
      import("../dist/api-auth.js"),
      import("../dist/durability.js"),
      import("../dist/multiplexer.js"),
      import("../dist/pi-adapter.js"),
      import("../dist/session-catalog.js"),
      import("../dist/tickets.js"),
      import("../dist/rpc-bridge.js"),
    ]);
    const deps = {
      ApiServer,
      ServiceBearerAuthenticator,
      FileDurabilityStore,
      wakeTicketId,
      Multiplexer,
      PiSessionFactory,
      FileSessionCatalog,
      FileMutationTicketStore,
      MutationTicketController,
    };

    firstHost = await startHost(deps, { stateDir, agentDir, workRoot });
    const unauthorized = await requestJson(firstHost.address, {
      path: "/v1/capabilities",
      headers: { Authorization: "Bearer wrong-token-value" },
    });
    assert.equal(unauthorized.status, 401);

    const specA = sessionSpec(
      workA,
      { mode: "new" },
      "persistent-a",
      "Return only the requested marker.",
      {},
    );
    const specB = sessionSpec(
      workB,
      { mode: "memory" },
      "memory-b",
      "Return the requested marker without tools.",
      { SESSION_SECRET_B: "secret-session-b" },
    );
    const createdA = await submitSession(firstHost.address, {
      requestId: "create-a",
      sessionId: "session-a",
      spec: specA,
    }, "create-a-once");
    const createdB = await submitSession(firstHost.address, {
      requestId: "create-b",
      sessionId: "session-b",
      spec: specB,
    }, "create-b-once");
    assert.equal(createdA.state, "succeeded");
    assert.equal(createdB.state, "succeeded");
    await assert.rejects(stat(extensionMarker), /ENOENT/);

    const packageDenied = await requestJson(firstHost.address, {
      method: "POST",
      path: "/v1/session",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "package-denied",
      },
      body: {
        requestId: "package-denied",
        sessionId: "package-denied",
        spec: {
          ...sessionSpec(workA, { mode: "memory" }, "denied", "deny", {}),
          settings: { packages: ["npm:untrusted"] },
        },
      },
    });
    assert.equal(packageDenied.status, 422);

    const pathTicket = await submitSession(firstHost.address, {
      requestId: "path-denied",
      sessionId: "path-denied",
      spec: sessionSpec(outside, { mode: "memory" }, "outside", "deny", {}),
    }, "path-denied-once");
    assert.equal(pathTicket.state, "failed");

    const controllerA = await connectWs(WebSocket, firstHost.address, "session-a", "pi-daemon-rpc.v1", { role: "controller" });
    const observerA = await connectWs(WebSocket, firstHost.address, "session-a", "pi-daemon-rpc.v1", { role: "observer" });
    const controllerB = await connectWs(WebSocket, firstHost.address, "session-b", "pi-daemon-rpc.v1", { role: "controller" });
    const readyA = await controllerA.next((value) => value.kind === "attach_ready");
    await observerA.next((value) => value.kind === "attach_ready");
    await controllerB.next((value) => value.kind === "attach_ready");

    controllerA.send({ kind: "command", command: { id: "prompt-a", type: "prompt", message: "PROMPT_A" } });
    controllerB.send({ kind: "command", command: { id: "prompt-b", type: "prompt", message: "PROMPT_B" } });
    assert.equal((await controllerA.next((value) => value.kind === "response" && value.response?.id === "prompt-a")).response.success, true);
    assert.equal((await controllerB.next((value) => value.kind === "response" && value.response?.id === "prompt-b")).response.success, true);
    await controllerA.next((value) => value.kind === "event" && value.event?.type === "agent_settled");
    await controllerB.next((value) => value.kind === "event" && value.event?.type === "agent_settled");
    const observerEvent = await observerA.next((value) => value.kind === "event");
    assert.equal(JSON.stringify(observerEvent).includes("PROMPT_B"), false);
    assert.equal(mock.maxActive, 1, "global turn semaphore must cover Pi RPC prompts");

    const originalState = await rpcCommand(controllerA, "state-original", "get_state");
    const originalSessionFile = originalState.response.data.sessionFile;
    assert.equal(typeof originalSessionFile, "string");
    assert.equal((await rpcCommand(controllerA, "new", "new_session")).response.success, true);
    assert.equal((await rpcCommand(controllerA, "switch", "switch_session", { sessionPath: originalSessionFile })).response.success, true);
    const forkMessages = await rpcCommand(controllerA, "fork-messages", "get_fork_messages");
    const forkEntry = forkMessages.response.data.messages[0];
    assert.ok(forkEntry);
    const forked = await rpcCommand(controllerA, "fork", "fork", { entryId: forkEntry.entryId });
    assert.equal(forked.response.success, true, JSON.stringify(forked.response));

    const replayCursor = observerEvent.cursor;
    observerA.close();
    controllerA.send({ kind: "command", command: { id: "prompt-a2", type: "prompt", message: "PROMPT_A2" } });
    await controllerA.next((value) => value.kind === "response" && value.response?.id === "prompt-a2");
    await controllerA.next((value) => value.kind === "event" && value.event?.type === "agent_settled");
    const replay = await connectWs(WebSocket, firstHost.address, "session-a", "pi-daemon-rpc.v1", { role: "observer", cursor: replayCursor });
    await replay.next((value) => value.kind === "attach_ready");
    assert.ok((await replay.next((value) => value.kind === "event")).sequence > observerEvent.sequence);

    const acp = await connectWs(WebSocket, firstHost.address, "session-a", "agent-client-protocol.v1");
    acp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "acceptance", version: "1" } } });
    assert.equal((await acp.next((value) => value.id === 1)).result.protocolVersion, 1);
    acp.send({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: "session-a", cwd: workA, mcpServers: [] } });
    assert.ok((await acp.next((value) => value.id === 2)).result);

    controllerA.close();
    const bridgeInput = new PassThrough();
    const bridgeOutput = new PassThrough();
    const bridgeStatus = new PassThrough();
    let bridgeText = "";
    bridgeOutput.setEncoding("utf8");
    bridgeOutput.on("data", (chunk) => (bridgeText += chunk));
    const bridge = new RpcStdioBridge({
      baseUrl: apiBase(firstHost.address),
      sessionRef: "session-a",
      bearerToken: TOKEN,
      input: bridgeInput,
      output: bridgeOutput,
      statusOutput: bridgeStatus,
      role: "observer",
      limits: { reconnectAttempts: 2, reconnectBaseDelayMs: 5, reconnectMaxDelayMs: 10 },
    });
    const bridgeRun = bridge.run();
    bridgeInput.end(`${JSON.stringify({ id: "bridge-state", type: "get_state" })}\n`);
    const bridgeResult = await bridgeRun;
    assert.equal(bridgeResult.code, 0);
    assert.equal(JSON.parse(bridgeText.trim()).id, "bridge-state");

    const queuedCommand = {
      protocolVersion: "1.0",
      requestId: "queued-after-restart",
      operation: "wake",
      sessionId: "session-a",
      generation: 1,
      idempotencyKey: "queued-after-restart",
      payload: { prompt: "PROMPT_A" },
    };
    const acceptedCommand = {
      ...queuedCommand,
      requestId: "accepted-after-restart",
      idempotencyKey: "accepted-after-restart",
    };
    await firstHost.durability.beginRequest(queuedCommand);
    await firstHost.durability.beginRequest(acceptedCommand);
    await firstHost.durability.markAccepted("session-a", "accepted-after-restart");

    replay.close();
    controllerB.close();
    acp.close();
    await firstHost.stop();
    firstHost = undefined;

    secondHost = await startHost(deps, { stateDir, agentDir, workRoot });
    assert.ok(
      secondHost.recovery.opened.includes("session-a"),
      JSON.stringify(secondHost.recovery),
    );
    const restarted = await connectWs(WebSocket, secondHost.address, "session-a", "pi-daemon-rpc.v1", { role: "observer", cursor: readyA.highWaterCursor });
    assert.equal((await restarted.next()).kind, "replay_gap");
    assert.equal((await restarted.next()).kind, "attach_ready");

    const queuedStatus = await waitForTicket(
      secondHost.address,
      wakeTicketId("session-a", "queued-after-restart"),
    );
    assert.equal(queuedStatus.state, "succeeded");
    const acceptedStatus = await waitForTicket(
      secondHost.address,
      wakeTicketId("session-a", "accepted-after-restart"),
    );
    assert.equal(acceptedStatus.state, "indeterminate");

    const memory = await requestJson(secondHost.address, {
      path: "/v1/session/session-b",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(memory.value.data.residency, "dormant");
    assert.equal(memory.value.data.environment.provisioned, false);
    const update = await requestJson(secondHost.address, {
      method: "PUT",
      path: "/v1/session/session-b?waitForTerminal=true",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "reprovision-b",
        "If-Match": memory.headers.etag,
      },
      body: {
        requestId: "reprovision-b",
        expectedGeneration: memory.value.data.generation,
        expectedRevision: memory.value.data.revision,
        spec: specB,
      },
    });
    assert.equal(update.status, 202);
    assert.equal(update.value.data.state, "succeeded");
    const currentB = await requestJson(secondHost.address, {
      path: "/v1/session/session-b",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const deleted = await requestJson(secondHost.address, {
      method: "DELETE",
      path: "/v1/session/session-b?retainArtifacts=false&waitForTerminal=true",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Idempotency-Key": "delete-b",
        "If-Match": currentB.headers.etag,
      },
    });
    assert.equal(deleted.value.data.state, "succeeded");
    assert.equal((await requestJson(secondHost.address, { path: "/v1/session/session-b", headers: { Authorization: `Bearer ${TOKEN}` } })).status, 404);

    const retainedState = await readTree(stateDir);
    assert.equal(retainedState.includes("secret-session-b"), false);
    assert.equal(retainedState.includes(TOKEN), false);
    assert.equal(calls.length, 0, `unexpected child process calls: ${JSON.stringify(calls)}`);
    assert.ok(mock.requests >= 3);
    restarted.close();
  } finally {
    await firstHost?.stop().catch(() => {});
    await secondHost?.stop().catch(() => {});
    await closeServer(mock.server).catch(() => {});
    for (const [name, original] of originals) childProcess[name] = original;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
