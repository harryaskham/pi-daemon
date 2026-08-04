#!/usr/bin/env node
import { chmod, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import { ServiceBearerAuthenticator } from "../dist/api-auth.js";
import { ApiServer } from "../dist/api-server.js";
import { DashboardNeutralApiController } from "../dist/dashboard-neutral-api.js";
import { createDashboardContractFixtures } from "../dist/dashboard-fixtures.js";
import { Multiplexer } from "../dist/multiplexer.js";
import { FileSessionCatalog } from "../dist/session-catalog.js";

const options = parseArgs(process.argv.slice(2));
const token = (await readFile(options.tokenFile, "utf8")).trim();
if (!token || token.length > 4096 || /[\r\n\0]/u.test(token)) throw new Error("disposable bearer file is invalid");
const hostInstanceId = `pidroid-${randomUUID()}`;
const fixture = createDashboardContractFixtures();

class FixtureRpcController {
  #listeners = new Set();

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
    return { id: command.id, type: "response", command: command.type, success: false, error: "readonly_fixture" };
  }

  respondToExtensionUi() {
    return false;
  }

  cancelPendingUi() {}
  setPromptScheduler() {}
}

class FixtureAdapter {
  constructor(sessionId, controller) {
    this.sessionId = sessionId;
    this.controller = controller;
  }

  identity() {
    return { sessionId: "pi-session-fixture-01" };
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
  controller = new FixtureRpcController();

  async open(request) {
    return new FixtureAdapter(request.sessionId, this.controller);
  }
}

const multiplexer =
  new Multiplexer({
    factory: new FixtureFactory(),
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

const server =
  new ApiServer({
    multiplexer,
    authenticator: new ServiceBearerAuthenticator(token),
    dashboardApi,
    host: "0.0.0.0",
    port: options.port,
    allowInsecureRemote: true,
  });
const address = await server.start();
const selfProbe = await verifyDisposableApi(address.port, token);
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

async function verifyDisposableApi(port, bearer) {
  const headers = { Authorization: `Bearer ${bearer}` };
  const origin = `http://127.0.0.1:${port}`;
  for (const path of [
    "/v1/capabilities",
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
  }
  const attach = await new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/v1/session/session-fixture-01/rpc?generation=3&role=observer`,
      "pi-daemon-rpc.v1",
      { headers },
    );
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("disposable RPC self-probe timed out"));
    }, 10_000);
    socket.once("message", (data) => {
      clearTimeout(timeout);
      const frame = JSON.parse(data.toString());
      socket.close();
      if (
        frame.kind !== "attach_ready" || frame.role !== "observer" ||
        frame.hostInstanceId !== hostInstanceId || frame.sessionId !== "session-fixture-01" ||
        frame.generation !== 3
      ) {
        reject(new Error("disposable RPC self-probe identity mismatch"));
      } else {
        resolve(true);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  return {
    capabilities: true,
    inventory: true,
    information: true,
    transcript: true,
    observerAttach: attach,
  };
}

function parseArgs(args) {
  const result = { port: undefined, tokenFile: undefined, readyFile: undefined, stateDir: undefined };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`missing value for ${key}`);
    if (key === "--port") result.port = Number.parseInt(value, 10);
    else if (key === "--token-file") result.tokenFile = value;
    else if (key === "--ready-file") result.readyFile = value;
    else if (key === "--state-dir") result.stateDir = value;
    else throw new Error(`unknown option ${key}`);
  }
  if (!Number.isInteger(result.port) || result.port < 1024 || result.port > 65535) throw new Error("invalid port");
  if (![result.tokenFile, result.readyFile, result.stateDir].every((value) => typeof value === "string" && value.length > 0)) {
    throw new Error("token, ready and state paths are required");
  }
  return result;
}
