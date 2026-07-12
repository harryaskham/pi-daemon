#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { PiDaemonClient, ProtocolResponseError } from "./client.js";
import { FileDurabilityStore } from "./durability.js";
import { Multiplexer, type SessionFactory } from "./multiplexer.js";
import { JsonLineLogger } from "./observability.js";
import { PiSessionFactory } from "./pi-adapter.js";
import { parseCommand } from "./protocol.js";
import { ProtocolServer } from "./server.js";
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
    ]),
  );
  const socketPath = resolve(requiredOption(options, "socket"));
  const stateDir = resolve(
    options.get("state-dir") ?? `${homedir()}/.local/state/pi-daemon`,
  );
  const agentDir = resolve(options.get("agent-dir") ?? getAgentDir());
  const allowedRoot = await realpath(resolve(requiredOption(options, "allow-root")));
  const durability = new FileDurabilityStore({ stateDir });
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
  const server = new ProtocolServer({ socketPath, multiplexer });
  await server.start();
  logger.write("info", "pi_daemon_ready", {
    socketPath,
    stateDir,
    agentDir,
    allowedRoot,
    hostInstanceId: multiplexer.hostInstanceId,
    restoredSessions: recovery.opened.length,
    replayedRequests: recovery.replayed.length,
    recoveryFailures: recovery.failures.length,
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
  pi-daemon probe --socket PATH
  pi-daemon request --socket PATH --json REQUEST
  pi-daemon version

Commands:
  serve    Start the owner-local Unix-socket service.
  probe    Perform a version/capability handshake.
  request  Send one low-level protocol command and print its response.
  version  Print the package version.
`;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
