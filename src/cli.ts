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
import {
  SessionCliUsageError,
  runHighLevelCli,
  type SessionCliDependencies,
} from "./session-cli.js";
import { SessionApiClientError } from "./session-client.js";
import { FileSessionCatalog } from "./session-catalog.js";
import { FileMutationTicketStore, MutationTicketController } from "./tickets.js";
import { PI_DAEMON_VERSION } from "./version.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface CliDependencies extends SessionCliDependencies {
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
      case "session":
      case "ticket":
      case "prompt":
      case "control":
      case "rpc":
      case "acp":
        return await runHighLevelCli(command, args, io, dependencies);
      default:
        throw new CliUsageError(`unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof SessionApiClientError) {
      io.stderr(
        `${JSON.stringify({
          error: {
            status: error.status,
            code: error.code,
            message: error.message,
            retryable: error.retryable,
          },
        })}\n`,
      );
      return error.retryable ? 75 : 1;
    }
    if (error instanceof ProtocolResponseError) {
      io.stderr(
        `${JSON.stringify({
          error: { code: error.code, message: error.message, retryable: error.retryable },
        })}\n`,
      );
      return error.retryable ? 75 : 1;
    }
    if (error instanceof CliUsageError || error instanceof SessionCliUsageError) {
      io.stderr(`${error.message}\nRun 'pi-daemon help' for usage.\n`);
      return 2;
    }
    const errorCode = safeCliErrorCode(error);
    const safeMessage = safeCliErrorMessage(error, errorCode);
    io.stderr(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        event: "pi_daemon_fatal",
        errorCode,
        message: safeMessage,
      })}\n`,
    );
    return 1;
  }
}

async function runProbe(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args, new Set(["socket", "timeout-ms"]));
  const socketPath = requiredOption(options, "socket");
  const timeoutMs = options.has("timeout-ms")
    ? integerOption(options, "timeout-ms", 1)
    : 5_000;
  const client = await PiDaemonClient.connect({
    socketPath,
    connectTimeoutMs: timeoutMs,
    requestTimeoutMs: timeoutMs,
  });
  try {
    const response = await client.handshake(`probe-${process.pid}`);
    io.stdout(`${JSON.stringify(response.data, null, 2)}\n`);
    return probeDataReady(response.data) ? 0 : 75;
  } finally {
    client.close();
  }
}

async function runRequest(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args, new Set(["socket", "json", "timeout-ms"]));
  const socketPath = requiredOption(options, "socket");
  const raw = requiredOption(options, "json");
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new CliUsageError("--json must contain one valid JSON command object");
  }
  const command = parseCommand(value);
  const timeoutMs = options.has("timeout-ms")
    ? integerOption(options, "timeout-ms", 1)
    : 30_000;
  const client = await PiDaemonClient.connect({
    socketPath,
    connectTimeoutMs: Math.min(timeoutMs, 5_000),
    requestTimeoutMs: timeoutMs,
  });
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
  const allowedRootValues = repeatedOptionValues(args, "allow-root");
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
      "recovery-open-timeout-ms",
      "recovery-total-timeout-ms",
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
    new Set(["allow-root"]),
  );
  const socketPath = resolve(requiredOption(options, "socket"));
  const stateDir = resolve(
    options.get("state-dir") ?? `${homedir()}/.local/state/pi-daemon`,
  );
  const agentDir = resolve(options.get("agent-dir") ?? getAgentDir());
  if (allowedRootValues.length === 0) {
    throw new CliUsageError("missing required option: --allow-root");
  }
  const allowedRoots = await Promise.all(
    allowedRootValues.map(async (root) => realpath(resolve(root))),
  );
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
  const tickets = new MutationTicketController(new FileMutationTicketStore({ stateDir }));
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
        allowedRoots,
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
  const recovery = await multiplexer.recover({
    queuedReplay: "background",
    ...(options.has("recovery-open-timeout-ms")
      ? {
          openTimeoutMs: integerOption(
            options,
            "recovery-open-timeout-ms",
            1,
          ),
        }
      : {}),
    ...(options.has("recovery-total-timeout-ms")
      ? {
          totalOpenTimeoutMs: integerOption(
            options,
            "recovery-total-timeout-ms",
            1,
          ),
        }
      : {}),
  });
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
        tickets,
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
  const lifecycleFields = () => ({
    hostInstanceId: multiplexer.hostInstanceId,
    retainedSessions: recovery.catalog.length,
    restoredSessions: recovery.opened.length,
    replayedRequests: recovery.replayed.length,
    recoveryFailures: recovery.failures.length,
    recovery: multiplexer.status().recovery,
    queuedMutationTickets: apiServer?.ticketRecovery?.queued.length ?? 0,
    indeterminateMutationTickets: apiServer?.ticketRecovery?.indeterminate.length ?? 0,
    prunedMutationTickets: apiServer?.ticketRecovery?.pruned ?? 0,
    api:
      apiAddress === undefined
        ? { enabled: false }
        : { enabled: true, host: apiAddress.host, port: apiAddress.port },
  });
  const initialStatus = multiplexer.status();
  logger.write(
    initialStatus.ready ? "info" : "warn",
    initialStatus.ready ? "pi_daemon_ready" : "pi_daemon_listening_degraded",
    lifecycleFields(),
  );
  if (!initialStatus.ready && initialStatus.recovery.phase === "recovering") {
    void Promise.allSettled([multiplexer.recoverySettled(), tickets.settled()]).then(() => {
      const settled = multiplexer.status();
      logger.write(
        settled.ready ? "info" : "warn",
        settled.ready ? "pi_daemon_ready" : "pi_daemon_recovery_degraded",
        lifecycleFields(),
      );
    });
  }

  let sweepRunning = false;
  const sweepInterval =
    idleSessionTtlMs === 0
      ? undefined
      : setInterval(() => {
          if (sweepRunning) {
            multiplexer.metrics.increment("idle_sweep_skipped_overlap");
            return;
          }
          sweepRunning = true;
          void multiplexer
            .sweepIdleSessions()
            .catch((error: unknown) => {
              multiplexer.metrics.increment("idle_sweep_failures");
              logger.write("warn", "idle_sweep_failed", {
                errorCode:
                  error !== null && typeof error === "object" && "code" in error
                    ? String((error as { code?: unknown }).code)
                    : error instanceof Error
                      ? error.name
                      : "unknown_error",
              });
            })
            .finally(() => {
              sweepRunning = false;
            });
        }, Math.min(60_000, idleSessionTtlMs));
  sweepInterval?.unref();
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (timeoutMs = 30_000): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shutdownPromise = (async () => {
      const deadline = Date.now() + timeoutMs;
      multiplexer.beginDrain();
      const transportBudget = Math.max(0, deadline - Date.now());
      const transportsStopped = await completesWithin(
        Promise.allSettled([apiServer?.stop(), server.stop()]),
        transportBudget,
      );
      if (!transportsStopped) {
        logger.write("warn", "transport_shutdown_timeout", { timeoutMs });
      }
      const disposeBudget = Math.max(0, deadline - Date.now());
      const disposed = await completesWithin(
        multiplexer.dispose(disposeBudget),
        disposeBudget,
      );
      if (!disposed) {
        logger.write("warn", "host_shutdown_timeout", { timeoutMs });
      }
    })();
    return shutdownPromise;
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

function safeCliErrorCode(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0 && code.length <= 128) return code;
  }
  return error instanceof Error && error.name.length > 0
    ? error.name.slice(0, 128)
    : "unknown_error";
}

function safeCliErrorMessage(error: unknown, code: string): string {
  if (
    error instanceof Error &&
    (error.message.includes("bearer source") ||
      error.message.startsWith("API listener requires exactly one bearer"))
  ) {
    return error.message;
  }
  if (
    error instanceof Error &&
    /^(insecure_state_path|corrupt_state|catalog_|recovery_|credentials_required)/.test(code)
  ) {
    return error.message;
  }
  return "pi-daemon command failed";
}

function probeDataReady(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const host = (value as Record<string, unknown>).host;
  return (
    host !== null &&
    typeof host === "object" &&
    !Array.isArray(host) &&
    (host as Record<string, unknown>).ready === true
  );
}

class CliUsageError extends Error {
  override readonly name = "CliUsageError";
}

function parseOptions(
  args: string[],
  allowed: Set<string>,
  repeatable: Set<string> = new Set(),
): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--") || token.length <= 2) {
      throw new CliUsageError(`unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    if (!allowed.has(name)) throw new CliUsageError(`unknown option: --${name}`);
    if (options.has(name) && !repeatable.has(name)) {
      throw new CliUsageError(`duplicate option: --${name}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`option --${name} requires a value`);
    }
    options.set(name, value);
    index += 1;
  }
  return options;
}

function repeatedOptionValues(args: string[], name: string): string[] {
  const flag = `--${name}`;
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`option ${flag} requires a value`);
    }
    values.push(value);
    index += 1;
  }
  return values;
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

async function completesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForSignal(shutdown: (timeoutMs?: number) => Promise<void>): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const cleanup = (): void => {
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
    };
    const run = (timeoutMs: number): void => {
      cleanup();
      const hardExit = setTimeout(() => process.exit(1), timeoutMs + 250);
      hardExit.unref();
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
  pi-daemon serve --socket PATH --allow-root PATH [--allow-root PATH ...] [--state-dir PATH] [--agent-dir PATH] [limit options]
                  [--api-port PORT] [--api-bind HOST]
                  [--api-token-file PATH | --api-token-fd FD]
                  [--api-allow-insecure-http true|false]
  pi-daemon probe --socket PATH [--timeout-ms N]
  pi-daemon request --socket PATH --json REQUEST [--timeout-ms N]
  pi-daemon session list|show|create|update|delete [options]
  pi-daemon ticket get|wait|reconcile [options]
  pi-daemon prompt --session REF --generation N --message TEXT [target options]
  pi-daemon control steer|follow-up|abort --session REF --generation N [options]
  pi-daemon rpc attach --session REF [pi-daemon-rpc options]
  pi-daemon rpc discover --session REF [API target options]
  pi-daemon acp discover --session REF [API target options]
  pi-daemon version

Commands:
  serve    Start the owner-local Unix-socket service.
  probe    Perform a version/capability handshake.
  request  Send one low-level protocol command and print its response.
  session  Manage retained sessions with high-level JSON commands.
  ticket   Inspect, wait for, or reconcile durable tickets.
  prompt   Submit one prompt through Unix wake or authenticated Pi RPC.
  control  Steer, follow up, or abort one resident session.
  rpc      Run the stock-RPC bridge or discover its WebSocket endpoint.
  acp      Discover the route-scoped ACP WebSocket endpoint.
  version  Print the package version.

High-level target options:
  --socket PATH               Owner-only Unix protocol (compatible operations)
  --url URL                   Authenticated API (default http://127.0.0.1:7463)
  --token-file PATH           Owner-only bearer file
  --token-fd FD               Inherited bearer descriptor, or PI_DAEMON_BEARER_TOKEN
  --allow-insecure-http true  Explicitly permit non-loopback plaintext
  --timeout-ms N              Bound connect/request/poll/turn waits

Create/update configuration:
  --spec-file PATH            Owner-only full SessionSpec JSON (may contain env)
  --spec-json JSON            Full SessionSpec without raw env values
  --cwd PATH --target new|continue|open|memory [typed model/tool options]

Recovery limits:
  --recovery-open-timeout-ms N
  --recovery-total-timeout-ms N

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
