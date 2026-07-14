#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { loadServiceBearer } from "./api-auth.js";
import { ApiServer } from "./api-server.js";
import { PiDaemonClient, ProtocolResponseError } from "./client.js";
import { FileDurabilityStore } from "./durability.js";
import { Multiplexer, type SessionFactory } from "./multiplexer.js";
import { JsonLineLogger } from "./observability.js";
import { PiSessionFactory } from "./pi-adapter.js";
import { parseCommand } from "./protocol.js";
import { ProtocolServer } from "./server.js";
import { FileSessionCatalog } from "./session-catalog.js";
import { PI_DAEMON_VERSION } from "./version.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface CliDependencies {
  factory?: SessionFactory;
  waitForShutdown?: (shutdown: () => Promise<void>) => Promise<void>;
}

const DEFAULT_IO: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function runCli(
  argv: string[],
  io: CliIo = DEFAULT_IO,
  dependencies: CliDependencies = {},
): Promise<number> {
  try {
    const [command, ...args] = argv;
    switch (command) {
      case "version":
      case "--version":
      case "-V":
        io.stdout(`${PI_DAEMON_VERSION}\n`);
        return 0;
      case "help":
      case "--help":
      case "-h":
      case undefined:
        io.stdout(helpText());
        return 0;
      case "probe":
        return await runProbe(args, io);
      case "request":
        return await runRequest(args, io);
      case "serve":
        return await runServe(args, io, dependencies);
      default:
        throw new CliUsageError(`unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof ProtocolResponseError) {
      io.stderr(
        `${JSON.stringify({
          error: { code: error.code, message: error.message, retryable: error.retryable },
        })}\n`,
      );
      return error.retryable ? 75 : 1;
    }
    io.stderr(`${error instanceof Error ? error.message : "unknown error"}\n`);
    if (error instanceof CliUsageError) io.stderr("Run 'pi-daemon help' for usage.\n");
    return error instanceof CliUsageError ? 2 : 1;
  }
}

async function runProbe(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args, new Set(["socket"]));
  const socketPath = requiredOption(options, "socket");
  const client = await PiDaemonClient.connect({ socketPath });
  try {
    const response = await client.handshake(`probe-${process.pid}`);
    io.stdout(`${JSON.stringify(response.data, null, 2)}\n`);
    return 0;
  } finally {
    client.close();
  }
}

async function runRequest(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args, new Set(["socket", "json"]));
  const socketPath = requiredOption(options, "socket");
  const raw = requiredOption(options, "json");
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new CliUsageError("--json must contain one valid JSON command object");
  }
  const command = parseCommand(value);
  const client = await PiDaemonClient.connect({ socketPath });
  try {
    const response = await client.request(command);
    io.stdout(`${JSON.stringify(response, null, 2)}\n`);
    return 0;
  } finally {
    client.close();
  }
}

async function runServe(
  args: string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const options = parseOptions(
    args,
    new Set([
      "socket",
      "state-dir",
      "agent-dir",
      "allow-root",
      "max-sessions",
      "max-concurrent-turns",
      "max-session-queue-depth",
      "idle-session-ttl-ms",
      "max-connections",
      "max-in-flight-requests-per-connection",
      "max-line-bytes",
      "max-event-bytes",
      "max-response-bytes",
      "max-outbound-bytes-per-connection",
      "api-bind",
      "api-port",
      "api-token-file",
      "api-token-fd",
      "api-allow-insecure-http",
    ]),
  );
  const socketPath = resolve(requiredOption(options, "socket"));
  const stateDir = resolve(
    options.get("state-dir") ?? `${homedir()}/.local/state/pi-daemon`,
  );
  const agentDir = resolve(options.get("agent-dir") ?? getAgentDir());
  const allowedRoot = await realpath(resolve(requiredOption(options, "allow-root")));
  const apiEnabled = options.has("api-port");
  if (
    !apiEnabled &&
    ["api-bind", "api-token-file", "api-token-fd", "api-allow-insecure-http"].some((name) =>
      options.has(name),
    )
  ) {
    throw new CliUsageError("API listener options require --api-port");
  }
  const durability = new FileDurabilityStore({ stateDir });
  const catalog = new FileSessionCatalog({ stateDir });
  const logger = new JsonLineLogger(io.stderr, { component: "pi-daemon" });
  const idleSessionTtlMs = options.has("idle-session-ttl-ms")
    ? integerOption(options, "idle-session-ttl-ms", 0)
    : 30 * 60 * 1000;
  const multiplexer = new Multiplexer({
    factory:
      dependencies.factory ??
      new PiSessionFactory({
        stateDir,
        agentDir,
        allowedRoots: [allowedRoot],
      }),
    durability,
    catalog,
    logger,
    idleSessionTtlMs,
    limits: {
      ...(options.has("max-sessions")
        ? { maxSessions: integerOption(options, "max-sessions", 1) }
        : {}),
      ...(options.has("max-concurrent-turns")
        ? { maxConcurrentTurns: integerOption(options, "max-concurrent-turns", 1) }
        : {}),
      ...(options.has("max-session-queue-depth")
        ? { maxSessionQueueDepth: integerOption(options, "max-session-queue-depth", 0) }
        : {}),
    },
  });
  const recovery = await multiplexer.recover();
  const server = new ProtocolServer({
    socketPath,
    multiplexer,
    limits: {
      ...(options.has("max-connections")
        ? { maxConnections: integerOption(options, "max-connections", 1) }
        : {}),
      ...(options.has("max-in-flight-requests-per-connection")
        ? {
            maxInFlightRequestsPerConnection: integerOption(
              options,
              "max-in-flight-requests-per-connection",
              1,
            ),
          }
        : {}),
      ...(options.has("max-line-bytes")
        ? { maxLineBytes: integerOption(options, "max-line-bytes", 1) }
        : {}),
      ...(options.has("max-event-bytes")
        ? { maxEventBytes: integerOption(options, "max-event-bytes", 1) }
        : {}),
      ...(options.has("max-response-bytes")
        ? { maxResponseBytes: integerOption(options, "max-response-bytes", 1) }
        : {}),
      ...(options.has("max-outbound-bytes-per-connection")
        ? {
            maxOutboundBytesPerConnection: integerOption(
              options,
              "max-outbound-bytes-per-connection",
              1,
            ),
          }
        : {}),
    },
  });
  let apiServer: ApiServer | undefined;
  let apiAddress: { host: string; port: number } | undefined;
  try {
    await server.start();
    if (apiEnabled) {
      const tokenFile = options.get("api-token-file");
      const tokenFd = options.has("api-token-fd")
        ? integerOption(options, "api-token-fd", 3)
        : undefined;
      const loaded = loadServiceBearer({
        ...(tokenFile === undefined ? {} : { tokenFile: resolve(tokenFile) }),
        ...(tokenFd === undefined ? {} : { tokenFd }),
      });
      apiServer = new ApiServer({
        multiplexer,
        authenticator: loaded.authenticator,
        host: options.get("api-bind") ?? "127.0.0.1",
        port: integerOption(options, "api-port", 0),
        allowInsecureRemote: options.has("api-allow-insecure-http")
          ? booleanOption(options, "api-allow-insecure-http")
          : false,
      });
      apiAddress = await apiServer.start();
    }
  } catch (error) {
    await apiServer?.stop().catch(() => {});
    await server.stop().catch(() => {});
    await multiplexer.dispose(1_000).catch(() => {});
    throw error;
  }
  logger.write("info", "pi_daemon_ready", {
    socketPath,
    stateDir,
    agentDir,
    allowedRoot,
    hostInstanceId: multiplexer.hostInstanceId,
    retainedSessions: recovery.catalog.length,
    restoredSessions: recovery.opened.length,
    replayedRequests: recovery.replayed.length,
    recoveryFailures: recovery.failures.length,
    api:
      apiAddress === undefined
        ? { enabled: false }
        : { enabled: true, host: apiAddress.host, port: apiAddress.port },
  });

  const sweepInterval =
    idleSessionTtlMs === 0
      ? undefined
      : setInterval(() => void multiplexer.sweepIdleSessions(), Math.min(60_000, idleSessionTtlMs));
  sweepInterval?.unref();
  let shuttingDown = false;
  const shutdown = async (timeoutMs = 30_000): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await multiplexer.drain(timeoutMs);
    await apiServer?.stop();
    await server.stop();
    await multiplexer.dispose(1_000);
  };
  try {
    if (dependencies.waitForShutdown !== undefined) {
      await dependencies.waitForShutdown(shutdown);
    } else {
      await waitForSignal(shutdown);
    }
  } finally {
    if (sweepInterval !== undefined) clearInterval(sweepInterval);
    await shutdown();
  }
  return 0;
}

class CliUsageError extends Error {
  override readonly name = "CliUsageError";
}

function parseOptions(args: string[], allowed: Set<string>): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--") || token.length <= 2) {
      throw new CliUsageError(`unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    if (!allowed.has(name)) throw new CliUsageError(`unknown option: --${name}`);
    if (options.has(name)) throw new CliUsageError(`duplicate option: --${name}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`option --${name} requires a value`);
    }
    options.set(name, value);
    index += 1;
  }
  return options;
}

function booleanOption(options: Map<string, string>, name: string): boolean {
  const raw = requiredOption(options, name);
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new CliUsageError(`--${name} must be true or false`);
}

function requiredOption(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (value === undefined || value.length === 0) {
    throw new CliUsageError(`missing required option: --${name}`);
  }
  return value;
}

function integerOption(options: Map<string, string>, name: string, minimum: number): number {
  const raw = requiredOption(options, name);
  if (!/^\d+$/.test(raw)) throw new CliUsageError(`--${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new CliUsageError(`--${name} must be at least ${minimum}`);
  }
  return value;
}

async function waitForSignal(shutdown: (timeoutMs?: number) => Promise<void>): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const cleanup = (): void => {
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
    };
    const run = (timeoutMs: number): void => {
      cleanup();
      void shutdown(timeoutMs).then(resolvePromise, reject);
    };
    const onSigterm = (): void => run(30_000);
    const onSigint = (): void => run(5_000);
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
  });
}

function helpText(): string {
  return `Pi Daemon ${PI_DAEMON_VERSION}

Usage:
  pi-daemon serve --socket PATH --allow-root PATH [--state-dir PATH] [--agent-dir PATH] [limit options]
                  [--api-port PORT] [--api-bind HOST]
                  [--api-token-file PATH | --api-token-fd FD]
                  [--api-allow-insecure-http true|false]
  pi-daemon probe --socket PATH
  pi-daemon request --socket PATH --json REQUEST
  pi-daemon version

Commands:
  serve    Start the owner-local Unix-socket service.
  probe    Perform a version/capability handshake.
  request  Send one low-level protocol command and print its response.
  version  Print the package version.

Protocol transport limits:
  --max-connections N
  --max-in-flight-requests-per-connection N
  --max-line-bytes N
  --max-event-bytes N
  --max-response-bytes N
  --max-outbound-bytes-per-connection N

API bearer sources (exactly one when --api-port is set):
  --api-token-file PATH, --api-token-fd FD, or PI_DAEMON_BEARER_TOKEN.
`;
}

async function isDirectInvocation(invokedPath: string | undefined): Promise<boolean> {
  if (invokedPath === undefined) return false;
  try {
    return (await realpath(invokedPath)) === (await realpath(fileURLToPath(import.meta.url)));
  } catch {
    return import.meta.url === pathToFileURL(invokedPath).href;
  }
}

if (await isDirectInvocation(process.argv[1])) {
  process.exitCode = await runCli(process.argv.slice(2));
}
