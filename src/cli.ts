#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { loadServiceBearer, SERVICE_BEARER_ENV } from "./api-auth.js";
import { ApiServer } from "./api-server.js";
import { bootstrapServicePaths } from "./bootstrap.js";
import { PiDaemonClient, ProtocolResponseError } from "./client.js";
import { loadPiDaemonConfig, PiDaemonConfigError } from "./config.js";
import { createDashboardServerFromConfig, type DashboardServer } from "./dashboard-server.js";
import { createDashboardStreamHandler } from "./dashboard-stream-router.js";
import { EmbeddedDashboardServiceRuntime } from "./dashboard-service-runtime.js";
import { FileDurabilityStore } from "./durability.js";
import { Multiplexer, type SessionFactory } from "./multiplexer.js";
import { JsonLineLogger } from "./observability.js";
import { PiSessionFactory } from "./pi-adapter.js";
import { installProcessStdioErrorHandlers } from "./process-stdio.js";
import { parseSupportedProtocolCommand } from "./protocol-v2.js";
import { RpcAttachmentManager } from "./rpc-attachments.js";
import { importConfiguredSchedules } from "./schedule-config.js";
import { FileScheduleStore } from "./schedule-store.js";
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
      case "schedule":
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
    if (error instanceof PiDaemonConfigError) {
      io.stderr(
        `${JSON.stringify({
          error: { code: error.code, message: error.message, retryable: false },
        })}\n`,
      );
      return 2;
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
  const command = parseSupportedProtocolCommand(value);
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
  const cliAllowedRootValues = repeatedOptionValues(args, "allow-root");
  const options = parseOptions(
    args,
    new Set([
      "config",
      "instance",
      "socket",
      "state-dir",
      "agent-dir",
      "auth-seed-file",
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
      "api-enabled",
      "api-bind",
      "api-port",
      "api-token-file",
      "api-token-fd",
      "api-allow-insecure-http",
    ]),
    new Set(["allow-root"]),
  );
  const cliConfigPath = options.get("config");
  const cliInstance = options.get("instance");
  const loadedConfig = await loadPiDaemonConfig({
    ...(cliConfigPath === undefined ? {} : { cliConfigPath }),
    ...(cliInstance === undefined ? {} : { cliInstance }),
  });
  const config = loadedConfig.config;
  const embeddedWebEnabled =
    config.web !== undefined &&
    config.web.enabled !== false &&
    (config.web.mode ?? "embedded") === "embedded";
  const configuredPath = (cliName: string, value: string | undefined): string | undefined => {
    const cliValue = options.get(cliName);
    if (cliValue !== undefined) return resolve(cliValue);
    return value === undefined ? undefined : loadedConfig.resolvePath(value);
  };
  const configuredSocket = configuredPath("socket", config.socketPath);
  if (configuredSocket === undefined) {
    throw new CliUsageError("missing required service socket (--socket or config socketPath)");
  }
  const socketPath = configuredSocket;
  const stateDir =
    configuredPath("state-dir", config.stateDir) ?? resolve(`${homedir()}/.local/state/pi-daemon`);
  const defaultAgentDir = resolve(getAgentDir());
  const agentDir = configuredPath("agent-dir", config.agentDir) ?? defaultAgentDir;
  const configuredAllowedRoots = config.allowedRoots?.map((root) => loadedConfig.resolvePath(root)) ?? [];
  const allowedRootValues =
    cliAllowedRootValues.length > 0
      ? cliAllowedRootValues.map((root) => resolve(root))
      : configuredAllowedRoots;
  if (allowedRootValues.length === 0) {
    throw new CliUsageError("missing required allowed root (--allow-root or config allowedRoots)");
  }
  const allowedRoots = await Promise.all(
    allowedRootValues.map(async (root) => realpath(root)),
  );
  const apiEnabled = options.has("api-enabled")
    ? booleanSetting(options, "api-enabled", undefined)!
    : options.has("api-port")
      ? true
      : (config.api?.enabled ?? config.api?.port !== undefined);
  const configuredApiPort = integerSetting(options, "api-port", config.api?.port, 0);
  if (apiEnabled && configuredApiPort === undefined) {
    throw new CliUsageError("API listener requires --api-port or config api.port");
  }
  if (
    !apiEnabled &&
    ["api-bind", "api-token-file", "api-token-fd", "api-allow-insecure-http"].some((name) =>
      options.has(name),
    )
  ) {
    throw new CliUsageError("API listener options require an enabled API and port");
  }
  const configuredTokenFile = configuredPath("api-token-file", config.api?.tokenFile);
  const tokenFd = integerSetting(options, "api-token-fd", undefined, 3);
  const bearerSourceCount = [
    configuredTokenFile,
    tokenFd,
    process.env[SERVICE_BEARER_ENV],
  ].filter((value) => value !== undefined).length;
  if (apiEnabled && bearerSourceCount > 1) {
    throw new CliUsageError("API listener bearer sources are mutually exclusive");
  }
  const apiTokenFile = apiEnabled
    ? configuredTokenFile === undefined && bearerSourceCount === 0
      ? join(stateDir, "api-token")
      : configuredTokenFile
    : undefined;
  const configuredAuthSeedFile = configuredPath("auth-seed-file", config.authSeedFile);
  const authSeedFile =
    configuredAuthSeedFile === undefined && agentDir !== defaultAgentDir
      ? join(defaultAgentDir, "auth.json")
      : configuredAuthSeedFile;
  const bootstrap = await bootstrapServicePaths({
    stateDir,
    socketPath,
    agentDir,
    ...(apiTokenFile === undefined ? {} : { apiTokenFile }),
    ...(authSeedFile === undefined ? {} : { authSeedFile }),
    authSeedRequired: configuredAuthSeedFile !== undefined,
  });

  const durability = new FileDurabilityStore({ stateDir });
  const catalog = new FileSessionCatalog({ stateDir });
  const tickets = new MutationTicketController(new FileMutationTicketStore({ stateDir }));
  const logger = new JsonLineLogger(io.stderr, { component: "pi-daemon" });
  const idleSessionTtlMs =
    integerSetting(
      options,
      "idle-session-ttl-ms",
      config.limits?.idleSessionTtlMs,
      0,
    ) ?? 30 * 60 * 1000;
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
      ...optionalSetting(
        "maxSessions",
        integerSetting(options, "max-sessions", config.limits?.maxSessions, 1),
      ),
      ...optionalSetting(
        "maxConcurrentTurns",
        integerSetting(
          options,
          "max-concurrent-turns",
          config.limits?.maxConcurrentTurns,
          1,
        ),
      ),
      ...optionalSetting(
        "maxSessionQueueDepth",
        integerSetting(
          options,
          "max-session-queue-depth",
          config.limits?.maxSessionQueueDepth,
          0,
        ),
      ),
    },
  });
  const recovery = await multiplexer.recover({
    queuedReplay: "background",
    ...optionalSetting(
      "openTimeoutMs",
      integerSetting(
        options,
        "recovery-open-timeout-ms",
        config.limits?.recoveryOpenTimeoutMs,
        1,
      ),
    ),
    ...optionalSetting(
      "totalOpenTimeoutMs",
      integerSetting(
        options,
        "recovery-total-timeout-ms",
        config.limits?.recoveryTotalTimeoutMs,
        1,
      ),
    ),
  });
  const scheduleStore = new FileScheduleStore({ stateDir });
  const scheduleImports = await importConfiguredSchedules({
    loadedConfig,
    store: scheduleStore,
    resolveSession: async (sessionRef) => (await multiplexer.retainedSession(sessionRef))?.sessionId,
  });
  const rpcAttachments = apiEnabled ? new RpcAttachmentManager(multiplexer) : undefined;
  let dashboardRuntime: EmbeddedDashboardServiceRuntime | undefined;
  let dashboardServer: DashboardServer | undefined;

  const server = new ProtocolServer({
    socketPath,
    multiplexer,
    limits: {
      ...optionalSetting(
        "maxConnections",
        integerSetting(options, "max-connections", config.limits?.maxConnections, 1),
      ),
      ...optionalSetting(
        "maxInFlightRequestsPerConnection",
        integerSetting(
          options,
          "max-in-flight-requests-per-connection",
          config.limits?.maxInFlightRequestsPerConnection,
          1,
        ),
      ),
      ...optionalSetting(
        "maxLineBytes",
        integerSetting(options, "max-line-bytes", config.limits?.maxLineBytes, 1),
      ),
      ...optionalSetting(
        "maxEventBytes",
        integerSetting(options, "max-event-bytes", config.limits?.maxEventBytes, 1),
      ),
      ...optionalSetting(
        "maxResponseBytes",
        integerSetting(
          options,
          "max-response-bytes",
          config.limits?.maxResponseBytes,
          1,
        ),
      ),
      ...optionalSetting(
        "maxOutboundBytesPerConnection",
        integerSetting(
          options,
          "max-outbound-bytes-per-connection",
          config.limits?.maxOutboundBytesPerConnection,
          1,
        ),
      ),
    },
  });
  let apiServer: ApiServer | undefined;
  let apiAddress: { host: string; port: number } | undefined;
  let dashboardAddress: { host: string; port: number; origin: string } | undefined;
  // Install process handlers before publishing the first listener. Later startup
  // work must not expose a window where SIGTERM takes the default signal exit.
  const signalLatch = dependencies.waitForShutdown === undefined ? latchShutdownSignal() : undefined;
  try {
    await server.start();
    if (apiEnabled || embeddedWebEnabled) {
      dashboardRuntime = await EmbeddedDashboardServiceRuntime.create({
        loadedConfig,
        stateDir,
        agentDir,
        allowedRoots,
        catalog,
        multiplexer,
        ...(rpcAttachments === undefined ? {} : { rpcAttachments }),
      });
      if (embeddedWebEnabled) {
        dashboardServer = await createDashboardServerFromConfig({
          loadedConfig,
          stateDir,
          backend: dashboardRuntime.backend,
          serverInstanceId: `embedded-${loadedConfig.instance}`,
          streamHandlerFactory: createDashboardStreamHandler,
        });
      }
    }
    if (apiEnabled) {
      const loaded = loadServiceBearer({
        ...(apiTokenFile === undefined ? {} : { tokenFile: apiTokenFile }),
        ...(tokenFd === undefined ? {} : { tokenFd }),
      });
      apiServer = new ApiServer({
        multiplexer,
        authenticator: loaded.authenticator,
        tickets,
        schedules: scheduleStore,
        ...(rpcAttachments === undefined ? {} : { rpcAttachments }),
        ...(dashboardRuntime === undefined ? {} : { dashboardApi: dashboardRuntime.neutralApi }),
        host: options.get("api-bind") ?? config.api?.bind ?? "127.0.0.1",
        port: configuredApiPort!,
        allowInsecureRemote:
          booleanSetting(
            options,
            "api-allow-insecure-http",
            config.api?.allowInsecureHttp,
          ) ?? false,
      });
      apiAddress = await apiServer.start();
    }
    dashboardAddress = await dashboardServer?.start();
  } catch (error) {
    signalLatch?.dispose();
    await dashboardServer?.stop().catch(() => {});
    await apiServer?.stop().catch(() => {});
    rpcAttachments?.dispose();
    await server.stop().catch(() => {});
    await dashboardRuntime?.stop().catch(() => {});
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
    scheduleImports,
    api:
      apiAddress === undefined
        ? { enabled: false }
        : { enabled: true, host: apiAddress.host, port: apiAddress.port },
    dashboard:
      dashboardAddress === undefined
        ? { enabled: false }
        : {
            enabled: true,
            host: dashboardAddress.host,
            port: dashboardAddress.port,
            origin: dashboardAddress.origin,
            inventory: dashboardRuntime?.inventory.status(),
          },
    ownershipRecovery: dashboardRuntime?.recovery,
    configuration: {
      instance: loadedConfig.instance,
      fileLoaded: loadedConfig.present,
      webConfigured: config.web !== undefined,
    },
    bootstrap: {
      bearerCreated: bootstrap.bearerCreated,
      auth: bootstrap.auth,
    },
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
        Promise.allSettled([
          dashboardServer?.stop(),
          apiServer?.stop(),
          server.stop(),
          dashboardRuntime?.stop(),
        ]),
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
      const signal = await signalLatch!.signal;
      const timeoutMs = signal === "SIGTERM" ? 30_000 : 5_000;
      const hardExit = setTimeout(() => process.exit(1), timeoutMs + 250);
      hardExit.unref();
      try {
        await shutdown(timeoutMs);
      } finally {
        clearTimeout(hardExit);
      }
    }
  } finally {
    signalLatch?.dispose();
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

function booleanSetting(
  options: Map<string, string>,
  name: string,
  configured: boolean | undefined,
): boolean | undefined {
  if (!options.has(name)) return configured;
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

function integerSetting(
  options: Map<string, string>,
  name: string,
  configured: number | undefined,
  minimum: number,
): number | undefined {
  if (options.has(name)) return integerOption(options, name, minimum);
  if (configured === undefined) return undefined;
  if (!Number.isSafeInteger(configured) || configured < minimum) {
    throw new CliUsageError(`configured ${name} must be at least ${minimum}`);
  }
  return configured;
}

function optionalSetting<const K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
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

function latchShutdownSignal(): {
  signal: Promise<"SIGTERM" | "SIGINT">;
  dispose: () => void;
} {
  let resolveSignal!: (signal: "SIGTERM" | "SIGINT") => void;
  let settled = false;
  const signal = new Promise<"SIGTERM" | "SIGINT">((resolve) => { resolveSignal = resolve; });
  const dispose = (): void => {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
  };
  const settle = (received: "SIGTERM" | "SIGINT"): void => {
    if (settled) return;
    settled = true;
    resolveSignal(received);
  };
  const onSigterm = (): void => settle("SIGTERM");
  const onSigint = (): void => settle("SIGINT");
  // Keep handlers installed through the drain. Supervisors may repeat a stop
  // signal; dropping back to the platform default mid-shutdown would surface as
  // a null exit code and bypass the bounded lifecycle cleanup.
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  return { signal, dispose };
}

function helpText(): string {
  return `Pi Daemon ${PI_DAEMON_VERSION}

Usage:
  pi-daemon serve [--config PATH] [--instance NAME]
                  --socket PATH --allow-root PATH [--allow-root PATH ...]
                  [--state-dir PATH] [--agent-dir PATH] [limit options]
                  [--auth-seed-file PATH]
                  [--api-enabled true|false] [--api-port PORT] [--api-bind HOST]
                  [--api-token-file PATH | --api-token-fd FD]
                  [--api-allow-insecure-http true|false]
  pi-daemon probe --socket PATH [--timeout-ms N]
  pi-daemon request --socket PATH --json REQUEST [--timeout-ms N]
  pi-daemon session list|show|create|update|delete [options]
  pi-daemon ticket get|wait|reconcile [options]
  pi-daemon schedule list|status|show|create|update|delete|enable|disable [options]
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
  schedule Manage durable schedules using owner-private JSON/YAML files.
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

Schedule configuration:
  --file PATH                 Owner-only JSON/YAML schedule definition
  --prompt-file PATH          Owner-only prompt content (never placed in argv)
  --revision N                Require an exact revision before mutation

Create/update configuration:
  --spec-file PATH            Owner-only full SessionSpec JSON (may contain env)
  --spec-json JSON            Full SessionSpec without raw env values
  --cwd PATH --target new|continue|open|memory [typed model/tool options]

Service configuration:
  --config PATH               YAML config (default ~/.config/pi/daemon/INSTANCE/config.yaml)
  --instance NAME             1-63 character service instance (default: default)
  PI_DAEMON_CONFIG            Config path fallback; CLI --config takes precedence
  PI_DAEMON_INSTANCE          Instance fallback; CLI --instance takes precedence
  Individual CLI values override YAML; existing flag-only invocation remains supported.
  An enabled web.mode=embedded block serves the packaged Dash at /dash/ on web.port.
  Secrets are file/fd/environment references, never literal YAML values.

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

First-launch bootstrap:
  Private state, socket, and agent directories are created if absent.
  A custom agent directory seeds auth once from the normal Pi auth file when present;
  --auth-seed-file PATH selects a required owner-private seed explicitly.

API bearer sources:
  --api-token-file PATH, --api-token-fd FD, or PI_DAEMON_BEARER_TOKEN.
  With none configured, an owner-only bearer is generated once at STATE_DIR/api-token.
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
  installProcessStdioErrorHandlers();
  process.exitCode = await runCli(process.argv.slice(2));
}
