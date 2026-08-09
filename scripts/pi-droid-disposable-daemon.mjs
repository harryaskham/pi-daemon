#!/usr/bin/env node
import { chmod, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import WebSocket from "ws";

import { ServiceBearerAuthenticator } from "../dist/api-auth.js";
import { ApiServer } from "../dist/api-server.js";
import { DashboardNeutralApiController } from "../dist/dashboard-neutral-api.js";
import { createDashboardContractFixtures } from "../dist/dashboard-fixtures.js";
import { Multiplexer } from "../dist/multiplexer.js";
import { FileSessionCatalog } from "../dist/session-catalog.js";
import { ShadowTuiAttachmentManager } from "../dist/shadow-tui-attachments.js";
import { FileMutationTicketStore, MutationTicketController } from "../dist/tickets.js";

const options = parseArgs(process.argv.slice(2));
const token = (await readFile(options.tokenFile, "utf8")).trim();
if (!token || token.length > 4096 || /[\r\n\0]/u.test(token)) throw new Error("disposable bearer file is invalid");
const hostInstanceId = `pidroid-${randomUUID()}`;
const fixture = createDashboardContractFixtures();

class FixtureRpcController {
  #listeners = new Set();

  constructor(interactive) {
    this.interactive = interactive;
  }

  snapshot() {
    return {
      rpcState: {
        sessionId: "pi-session-fixture-01",
        thinkingLevel: "off",
        isStreaming: false,
        messageCount: 3,
        pendingMessageCount: 0,
      },
      leafId: "entry-assistant-01",
    };
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async handle(command) {
    if (command.type === "get_state") {
      return { id: command.id, type: "response", command: "get_state", success: true, data: this.snapshot().rpcState };
    }
    if (command.type === "get_entries") {
      return {
        id: command.id,
        type: "response",
        command: "get_entries",
        success: true,
        data: { entries: [], leafId: "entry-assistant-01" },
      };
    }
    if (this.interactive && command.type === "get_tree") {
      return {
        id: command.id,
        type: "response",
        command: "get_tree",
        success: true,
        data: {
          leafId: "entry-assistant-01",
          tree: [
            {
              entry: { id: "entry-system-01", parentId: null, type: "session_info" },
              label: "Session start",
              children: [
                {
                  entry: { id: "entry-user-01", parentId: "entry-system-01", type: "message" },
                  label: "User",
                  children: [
                    {
                      entry: { id: "entry-assistant-01", parentId: "entry-user-01", type: "message" },
                      label: "Assistant",
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      };
    }
    if (this.interactive && command.type === "prompt") {
      this.#emit({ type: "agent_start" });
      if (command.message === "hold-until-disconnect") return new Promise(() => {});
      setTimeout(() => this.#emit({ type: "agent_settled" }), 80);
      return { id: command.id, type: "response", command: "prompt", success: true };
    }
    return { id: command.id, type: "response", command: command.type, success: false, error: "readonly_fixture" };
  }

  #emit(event) {
    for (const listener of this.#listeners) listener(event);
  }

  respondToExtensionUi() {
    return false;
  }

  cancelPendingUi() {}
  setPromptScheduler() {}
}

class FixtureAdapter {
  constructor(sessionId, controller, conversationIdentity) {
    this.sessionId = sessionId;
    this.controller = controller;
    this.conversationIdentity = conversationIdentity;
  }

  identity() {
    return this.conversationIdentity;
  }

  async prompt() {
    throw new Error("disposable readonly daemon rejects prompts");
  }

  async rpcController() {
    return this.controller;
  }

  async dispose() {}
}

class FixtureFactory {
  constructor(interactive) {
    this.controller = new FixtureRpcController(interactive);
  }

  async open(request) {
    const memoryOnly = request.session?.mode === "memory";
    return new FixtureAdapter(
      request.sessionId,
      this.controller,
      {
        sessionId: request.sessionId === "session-fixture-01" ? "pi-session-fixture-01" : `pi-${request.sessionId}`,
        ...(memoryOnly ? {} : { sessionFile: join(options.stateDir, `${request.sessionId}.jsonl`) }),
      },
    );
  }
}

const multiplexer =
  new Multiplexer({
    factory: new FixtureFactory(options.interactive),
    catalog: new FileSessionCatalog({ stateDir: options.stateDir }),
    hostInstanceId,
  });
await multiplexer.recover();
await multiplexer.open({
  protocolVersion: "1.0",
  requestId: "open-disposable-readonly",
  operation: "open",
  sessionId: "session-fixture-01",
  generation: 3,
  payload: {
    cwd: options.stateDir,
    session: { mode: "memory" },
    resources: {
      extensions: "none",
      skills: "none",
      promptTemplates: "none",
      themes: "none",
      contextFiles: "none",
      tools: "none",
    },
  },
});

const dashboardApi =
  new DashboardNeutralApiController({
    inventory: {
      async list() {
        return fixture.inventory;
      },
      async getInfo(inventoryId) {
        return inventoryId === fixture.sessionInfo.inventoryId ? fixture.sessionInfo : undefined;
      },
    },
    projector: {
      async project() {
        return fixture.transcript;
      },
    },
    sessionDefaults: fixture.serviceCapabilities.sessionDefaults,
    ownership: {
      async activateSession() {
        throw new Error("readonly fixture");
      },
      async getActivation() {
        throw new Error("readonly fixture");
      },
      async exportSession() {
        throw new Error("readonly fixture");
      },
      async getExport() {
        throw new Error("readonly fixture");
      },
      async renewLease() {
        throw new Error("readonly fixture");
      },
    },
  });

const dashboardTuiAttachments = options.interactive
  ? new ShadowTuiAttachmentManager({
      async openTuiChannel(channelOptions) {
        if (channelOptions.sessionRef !== "session-fixture-01") throw new Error("fixture session not found");
        let role = channelOptions.role;
        const identity = { hostInstanceId, sessionId: "session-fixture-01", generation: 3 };
        const snapshot = {
          identity,
          dimensions: channelOptions.dimensions,
          rows: [
            { row: 0, runs: [{ text: "Pi Droid interactive", style: { bold: true, foreground: "#88D5E7" } }] },
            { row: 1, runs: [{ text: "Observer input is inert until control is granted" }] },
            { row: 2, runs: [{ text: "Disposable daemon ready" }] },
          ],
          cursor: { row: 3, column: 0, visible: true, shape: "block" },
          title: "Pi Droid disposable TUI",
          highWaterCursor: "tui:fixture:0",
        };
        return {
          presentation: "tui",
          identity,
          get role() { return role; },
          snapshot,
          async resize() {},
          async sendInput() {
            if (role !== "controller") throw new Error("controller_required");
          },
          async requestControl(correlationId) {
            role = "controller";
            return { correlationId, state: "completed" };
          },
          async releaseControl(correlationId) {
            role = "observer";
            return { correlationId, state: "completed" };
          },
          subscribe() { return () => {}; },
          async close() {},
        };
      },
    })
  : undefined;

const tickets = new MutationTicketController(new FileMutationTicketStore({ stateDir: options.stateDir }));
const server =
  new ApiServer({
    multiplexer,
    authenticator: new ServiceBearerAuthenticator(token),
    tickets,
    dashboardApi,
    dashboardTuiAttachments,
    host: "0.0.0.0",
    port: options.port,
    allowInsecureRemote: true,
  });
const address = await server.start();
const selfProbe = await verifyDisposableApi(address.port, token, options.interactive);
await writeFile(
  options.readyFile,
  `${JSON.stringify({
    schemaVersion: 1,
    host: address.host,
    port: address.port,
    hostInstanceId,
    sessionId: "session-fixture-01",
    generation: 3,
    stateDir: options.stateDir,
    selfProbe,
  })}\n`,
  { mode: 0o600 },
);
await chmod(options.readyFile, 0o600);
process.stderr.write(`${JSON.stringify({ event: "pi_droid_disposable_ready", port: address.port, hostInstanceId })}\n`);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  process.stderr.write(`${JSON.stringify({ event: "pi_droid_disposable_stopping", signal })}\n`);
  await server.stop();
  await multiplexer.drain(1_000);
  process.exit(0);
}
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));

async function verifyDisposableApi(port, bearer, requireControlGrant) {
  const headers = { Authorization: `Bearer ${bearer}` };
  const origin = `http://127.0.0.1:${port}`;
  let configuredDefaults;
  for (const path of [
    "/v1/capabilities",
    "/v1/dashboard/capabilities",
    "/v1/session?limit=50",
    "/v1/session/session-fixture-01",
    "/v1/dashboard/inventory?limit=50",
    "/v1/dashboard/inventory/inventory-fixture-01",
    "/v1/dashboard/inventory/inventory-fixture-01/transcript?limit=50",
  ]) {
    const response = await fetch(`${origin}${path}`, { headers });
    if (!response.ok) throw new Error(`disposable API self-probe failed: ${path} ${response.status}`);
    const envelope = await response.json();
    if (envelope.ok !== true || envelope.hostInstanceId !== hostInstanceId) {
      throw new Error(`disposable API self-probe envelope failed: ${path}`);
    }
    if (path === "/v1/dashboard/capabilities") configuredDefaults = envelope.data.sessionDefaults;
  }
  if (
    configuredDefaults?.sources?.cwd !== "configured" ||
    !configuredDefaults.spec?.cwd ||
    !["persistent", "memory"].includes(configuredDefaults.spec.persistence)
  ) {
    throw new Error("disposable configured defaults self-probe failed");
  }
  const createIdentity = { requestId: "pidroid-create-proof", idempotencyKey: "pidroid-create-proof-once" };
  const defaultSpec = configuredDefaults.spec;
  const createResponse = await fetch(`${origin}/v1/session?waitForTerminal=true`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "X-Request-Id": createIdentity.requestId,
      "Idempotency-Key": createIdentity.idempotencyKey,
    },
    body: JSON.stringify({
      requestId: createIdentity.requestId,
      sessionId: "session-pidroid-create-proof",
      spec: {
        cwd: defaultSpec.cwd,
        name: "Pi Droid create proof",
        target: { mode: defaultSpec.persistence === "memory" ? "memory" : "new" },
        ...(defaultSpec.model === undefined ? {} : { model: defaultSpec.model }),
        tools: defaultSpec.tools,
        resources: defaultSpec.resources,
        isolation: defaultSpec.isolation,
      },
    }),
  });
  const createEnvelope = await createResponse.json();
  if (
    createResponse.status !== 202 || createEnvelope.ok !== true ||
    createEnvelope.hostInstanceId !== hostInstanceId || createEnvelope.data.state !== "succeeded" ||
    createEnvelope.data.requestId !== createIdentity.requestId ||
    createEnvelope.data.idempotencyKey !== createIdentity.idempotencyKey
  ) {
    throw new Error(
      `disposable configured create self-probe failed: ${JSON.stringify({
        status: createResponse.status,
        ok: createEnvelope.ok,
        state: createEnvelope.data?.state,
        errorCode: createEnvelope.data?.error?.code ?? createEnvelope.error?.code,
      })}`,
    );
  }
  for (const path of [
    `/v1/ticket/${encodeURIComponent(createEnvelope.data.ticketId)}`,
    "/v1/session/session-pidroid-create-proof",
  ]) {
    const response = await fetch(`${origin}${path}`, { headers });
    const envelope = await response.json();
    if (!response.ok || envelope.ok !== true || envelope.hostInstanceId !== hostInstanceId) {
      throw new Error(`disposable created resource self-probe failed: ${path}`);
    }
  }
  const rpcProbe = await new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/v1/session/session-fixture-01/rpc?generation=3&role=observer`,
      "pi-daemon-rpc.v1",
      { headers },
    );
    let observerAttached = false;
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("disposable RPC self-probe timed out"));
    }, 10_000);
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (!observerAttached) {
        if (
          frame.kind !== "attach_ready" || frame.role !== "observer" ||
          frame.hostInstanceId !== hostInstanceId || frame.sessionId !== "session-fixture-01" ||
          frame.generation !== 3
        ) {
          clearTimeout(timeout);
          socket.close();
          reject(new Error("disposable RPC self-probe identity mismatch"));
          return;
        }
        observerAttached = true;
        if (requireControlGrant) {
          socket.send(JSON.stringify({ kind: "control", action: "request_control" }));
          return;
        }
        clearTimeout(timeout);
        socket.close();
        resolve({ observerAttach: true, controlGrant: false });
        return;
      }
      if (frame.kind !== "control" || frame.action !== "control_granted") {
        clearTimeout(timeout);
        socket.close();
        reject(new Error("disposable RPC control self-probe failed"));
        return;
      }
      clearTimeout(timeout);
      socket.close();
      resolve({ observerAttach: true, controlGrant: true });
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  return {
    capabilities: true,
    configuredDefaults: true,
    sessionList: true,
    sessionInformation: true,
    configuredCreate: true,
    ticketReconciliationIdentity: true,
    inventory: true,
    information: true,
    transcript: true,
    observerAttach: rpcProbe.observerAttach,
    controlGrant: rpcProbe.controlGrant,
  };
}

function parseArgs(args) {
  const result = { port: undefined, tokenFile: undefined, readyFile: undefined, stateDir: undefined, interactive: false };
  for (let index = 0; index < args.length;) {
    const key = args[index];
    if (key === "--interactive") {
      result.interactive = true;
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) throw new Error(`missing value for ${key}`);
    if (key === "--port") result.port = Number.parseInt(value, 10);
    else if (key === "--token-file") result.tokenFile = value;
    else if (key === "--ready-file") result.readyFile = value;
    else if (key === "--state-dir") result.stateDir = value;
    else throw new Error(`unknown option ${key}`);
    index += 2;
  }
  if (!Number.isInteger(result.port) || result.port < 1024 || result.port > 65535) throw new Error("invalid port");
  if (![result.tokenFile, result.readyFile, result.stateDir].every((value) => typeof value === "string" && value.length > 0)) {
    throw new Error("token, ready and state paths are required");
  }
  return result;
}
