import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  atomicWritePrivateJson,
  ensurePrivateDirectory,
  validatePrivateFileIfExists,
} from "./durability.js";

const WATCHDOG_SCHEMA_VERSION = 1;
const MAX_WATCHDOG_STATE_BYTES = 64 * 1024;
const MAX_COMMAND_STDOUT_BYTES = 64 * 1024;
const INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;

export type WatchdogComponent = "api" | "web";
export type WatchdogProbePhase = "healthy" | "degraded" | "failed" | "blocked";
export type WatchdogPhase = "healthy" | "degraded" | "recovering";
export type WatchdogSupervisor = "launchd" | "systemd" | "supervisord";

export interface WatchdogProbeTarget {
  component: WatchdogComponent;
  url: string;
  expectedStatus: number;
  authority?: string;
}

export interface WatchdogProbeResult {
  component: WatchdogComponent;
  phase: WatchdogProbePhase;
  latencyMs: number;
  statusCode?: number;
  errorCode?: string;
}

export interface WatchdogRecoveryResult {
  ok: boolean;
  supervisor: WatchdogSupervisor;
  escalated: boolean;
  durationMs: number;
  errorCode?: string;
}

export interface WatchdogComponentState {
  consecutiveFailures: number;
  recoveryAttempted: boolean;
  lastProbe: WatchdogProbeResult;
  lastRecovery?: WatchdogRecoveryResult & { attemptedAt: string };
}

export interface ServiceWatchdogState {
  schemaVersion: 1;
  instance: string;
  phase: WatchdogPhase;
  updatedAt: string;
  components: Partial<Record<WatchdogComponent, WatchdogComponentState>>;
}

export interface ServiceWatchdogStore {
  load(instance: string): Promise<ServiceWatchdogState | undefined>;
  save(state: ServiceWatchdogState): Promise<void>;
}

export interface WatchdogRecovery {
  readonly supervisor: WatchdogSupervisor;
  recover(
    component: WatchdogComponent,
    probe: () => Promise<WatchdogProbeResult>,
  ): Promise<WatchdogRecoveryResult>;
}

export interface ServiceWatchdogOptions {
  instance: string;
  api: WatchdogProbeTarget;
  web?: WatchdogProbeTarget;
  store: ServiceWatchdogStore;
  recovery: WatchdogRecovery;
  probeTimeoutMs: number;
  degradedAfterMs: number;
  failureThreshold: number;
  probe?: (
    target: WatchdogProbeTarget,
    timeoutMs: number,
    degradedAfterMs: number,
  ) => Promise<WatchdogProbeResult>;
  now?: () => Date;
}

export class FileServiceWatchdogStore implements ServiceWatchdogStore {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  async load(instance: string): Promise<ServiceWatchdogState | undefined> {
    try {
      await validatePrivateFileIfExists(this.path, "service watchdog state");
      const info = await lstat(this.path);
      if (info.size <= 0 || info.size > MAX_WATCHDOG_STATE_BYTES) {
        throw new Error("service watchdog state exceeds its byte bound");
      }
      const raw = await readFile(this.path, "utf8");
      return parseWatchdogState(JSON.parse(raw) as unknown, instance);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(state: ServiceWatchdogState): Promise<void> {
    await ensurePrivateDirectory(dirname(this.path), "service watchdog state directory");
    await atomicWritePrivateJson(this.path, state);
  }
}

export class ServiceWatchdog {
  readonly #options: ServiceWatchdogOptions;
  readonly #probe: NonNullable<ServiceWatchdogOptions["probe"]>;
  readonly #now: () => Date;

  constructor(options: ServiceWatchdogOptions) {
    assertInstance(options.instance);
    assertTarget(options.api, "api");
    if (options.web !== undefined) assertTarget(options.web, "web");
    positiveInteger(options.probeTimeoutMs, "probeTimeoutMs");
    positiveInteger(options.degradedAfterMs, "degradedAfterMs");
    positiveInteger(options.failureThreshold, "failureThreshold");
    if (options.degradedAfterMs > options.probeTimeoutMs) {
      throw new RangeError("degradedAfterMs cannot exceed probeTimeoutMs");
    }
    this.#options = options;
    this.#probe = options.probe ?? semanticHttpProbe;
    this.#now = options.now ?? (() => new Date());
  }

  async cycle(): Promise<ServiceWatchdogState> {
    const prior =
      (await this.#options.store.load(this.#options.instance)) ??
      initialState(this.#options.instance, this.#now());
    const components: ServiceWatchdogState["components"] = { ...prior.components };

    const api = await this.#runProbe(this.#options.api);
    components.api = updateComponent(components.api, api);

    if (this.#options.web !== undefined) {
      const web =
        api.phase === "healthy"
          ? await this.#runProbe(this.#options.web)
          : blockedProbe("web", "api_not_healthy");
      components.web = updateComponent(components.web, web);
    }

    let state: ServiceWatchdogState = {
      schemaVersion: WATCHDOG_SCHEMA_VERSION,
      instance: this.#options.instance,
      phase: overallPhase(components, this.#options.web !== undefined),
      updatedAt: this.#now().toISOString(),
      components,
    };

    const recoveryComponent = nextRecoveryComponent(
      state,
      this.#options.failureThreshold,
    );
    if (recoveryComponent === undefined) {
      await this.#options.store.save(state);
      return state;
    }

    const component = state.components[recoveryComponent]!;
    state = {
      ...state,
      phase: "recovering",
      updatedAt: this.#now().toISOString(),
      components: {
        ...state.components,
        [recoveryComponent]: {
          ...component,
          // Persist before invoking the supervisor. A watchdog crash must not
          // turn an indeterminate recovery into an automatic restart loop.
          recoveryAttempted: true,
        },
      },
    };
    await this.#options.store.save(state);

    const target = recoveryComponent === "api" ? this.#options.api : this.#options.web!;
    const attemptedAt = this.#now().toISOString();
    const recovery = await this.#options.recovery.recover(
      recoveryComponent,
      () => this.#runProbe(target),
    );
    const attempted = state.components[recoveryComponent]!;
    state = {
      ...state,
      phase: "degraded",
      updatedAt: this.#now().toISOString(),
      components: {
        ...state.components,
        [recoveryComponent]: {
          ...attempted,
          lastRecovery: { ...recovery, attemptedAt },
        },
      },
    };
    await this.#options.store.save(state);
    return state;
  }

  #runProbe(target: WatchdogProbeTarget): Promise<WatchdogProbeResult> {
    return this.#probe(
      target,
      this.#options.probeTimeoutMs,
      this.#options.degradedAfterMs,
    );
  }
}

export interface NativeSupervisorRecoveryOptions {
  instance: string;
  supervisor: WatchdogSupervisor;
  gracefulTimeoutMs: number;
  commandTimeoutMs?: number;
  commandRunner?: CommandRunner;
  pollIntervalMs?: number;
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Bounded, in-memory supervisor metadata; never persisted or logged. */
  stdout?: string;
  errorCode?: string;
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<CommandResult>;

export class NativeSupervisorRecovery implements WatchdogRecovery {
  readonly supervisor: WatchdogSupervisor;
  readonly #instance: string;
  readonly #gracefulTimeoutMs: number;
  readonly #commandTimeoutMs: number;
  readonly #commandRunner: CommandRunner;
  readonly #pollIntervalMs: number;

  constructor(options: NativeSupervisorRecoveryOptions) {
    assertInstance(options.instance);
    this.#instance = options.instance;
    if (!["launchd", "systemd", "supervisord"].includes(options.supervisor)) {
      throw new Error("watchdog supervisor is invalid");
    }
    this.supervisor = options.supervisor;
    this.#gracefulTimeoutMs = positiveInteger(
      options.gracefulTimeoutMs,
      "gracefulTimeoutMs",
    );
    this.#commandTimeoutMs = positiveInteger(
      options.commandTimeoutMs ?? options.gracefulTimeoutMs + 10_000,
      "commandTimeoutMs",
    );
    this.#commandRunner = options.commandRunner ?? runBoundedCommand;
    this.#pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? 500,
      "pollIntervalMs",
    );
  }

  async recover(
    component: WatchdogComponent,
    probe: () => Promise<WatchdogProbeResult>,
  ): Promise<WatchdogRecoveryResult> {
    const startedAt = performance.now();
    if (this.supervisor === "launchd") {
      return this.#recoverLaunchd(component, probe, startedAt);
    }
    const command =
      this.supervisor === "systemd"
        ? {
            executable: "systemctl",
            args: ["--user", "restart", `${serviceName(component, this.#instance)}.service`],
          }
        : {
            executable: "supervisorctl",
            args: ["restart", serviceName(component, this.#instance)],
          };
    const result = await this.#commandRunner(
      command.executable,
      command.args,
      this.#commandTimeoutMs,
    );
    return commandRecoveryResult(this.supervisor, result, startedAt, false);
  }

  async #recoverLaunchd(
    component: WatchdogComponent,
    probe: () => Promise<WatchdogProbeResult>,
    startedAt: number,
  ): Promise<WatchdogRecoveryResult> {
    const uid = process.getuid?.();
    if (uid === undefined) {
      return {
        ok: false,
        supervisor: "launchd",
        escalated: false,
        durationMs: elapsed(startedAt),
        errorCode: "uid_unavailable",
      };
    }
    const target = `gui/${uid}/${launchdLabel(component, this.#instance)}`;
    const originalPid = await this.#launchdPid(target);
    if (originalPid === undefined) {
      // No live PID exists to kill. Ask launchd to start only this exact job;
      // `-k` would misrepresent this as a forced escalation.
      const started = await this.#commandRunner(
        "launchctl",
        ["kickstart", target],
        this.#commandTimeoutMs,
      );
      return commandRecoveryResult("launchd", started, startedAt, false);
    }

    const graceful = await this.#commandRunner(
      "launchctl",
      ["kill", "SIGTERM", target],
      Math.min(this.#commandTimeoutMs, 5_000),
    );
    if (commandSucceeded(graceful)) {
      const deadline = performance.now() + this.#gracefulTimeoutMs;
      while (performance.now() < deadline) {
        await delay(Math.min(this.#pollIntervalMs, Math.max(1, deadline - performance.now())));
        const result = await probe();
        if (result.phase === "healthy" || result.phase === "degraded") {
          return {
            ok: true,
            supervisor: "launchd",
            escalated: false,
            durationMs: elapsed(startedAt),
          };
        }
        const currentPid = await this.#launchdPid(target);
        if (currentPid === undefined || currentPid !== originalPid) {
          // Graceful drain succeeded. A replacement may legitimately spend
          // minutes in startup under disk pressure; never kill that new PID
          // merely because its listener is not ready yet.
          return {
            ok: true,
            supervisor: "launchd",
            escalated: false,
            durationMs: elapsed(startedAt),
          };
        }
      }
    }

    const forced = await this.#commandRunner(
      "launchctl",
      ["kickstart", "-k", target],
      this.#commandTimeoutMs,
    );
    return commandRecoveryResult("launchd", forced, startedAt, true);
  }

  async #launchdPid(target: string): Promise<number | undefined> {
    const result = await this.#commandRunner(
      "launchctl",
      ["print", target],
      Math.min(this.#commandTimeoutMs, 5_000),
    );
    if (!commandSucceeded(result) || result.stdout === undefined) return undefined;
    const match = /^\s*pid = ([0-9]+)\s*$/m.exec(result.stdout);
    if (match === null) return undefined;
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  }
}

export async function semanticHttpProbe(
  target: WatchdogProbeTarget,
  timeoutMs: number,
  degradedAfterMs: number,
): Promise<WatchdogProbeResult> {
  const startedAt = performance.now();
  let url: URL;
  try {
    url = validatedProbeUrl(target.url);
  } catch {
    return {
      component: target.component,
      phase: "failed",
      latencyMs: elapsed(startedAt),
      errorCode: "invalid_probe_url",
    };
  }
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolveProbe) => {
    let settled = false;
    const settle = (result: Omit<WatchdogProbeResult, "component" | "latencyMs">): void => {
      if (settled) return;
      settled = true;
      resolveProbe({
        component: target.component,
        latencyMs: elapsed(startedAt),
        ...result,
      });
    };
    const authority = target.authority === undefined
      ? undefined
      : validatedAuthority(target.authority);
    let request;
    try {
      request = transport(
        url,
        {
          method: "GET",
          headers: {
            Connection: "close",
            ...(authority === undefined ? {} : { Host: authority }),
          },
          ...(url.protocol === "https:" && authority !== undefined
            ? { servername: authorityHostname(authority) }
            : {}),
          signal: AbortSignal.timeout(timeoutMs),
        },
        (response) => {
          const statusCode = response.statusCode ?? 0;
          response.resume();
          const latencyMs = elapsed(startedAt);
          settle(
            statusCode !== target.expectedStatus
              ? { phase: "failed", statusCode, errorCode: "unexpected_status" }
              : latencyMs > degradedAfterMs
                ? { phase: "degraded", statusCode }
                : { phase: "healthy", statusCode },
          );
          response.destroy();
        },
      );
    } catch {
      settle({ phase: "failed", errorCode: "probe_start_failed" });
      return;
    }
    request.once("error", (error: NodeJS.ErrnoException) => {
      settle({
        phase: "failed",
        errorCode:
          error.name === "AbortError" || error.code === "ABORT_ERR"
            ? "timeout"
            : safeErrorCode(error),
      });
    });
    request.end();
  });
}

export async function runBoundedCommand(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolveCommand) => {
    let settled = false;
    let timedOut = false;
    let outputTooLarge = false;
    let stdoutBytes = 0;
    const stdout: Buffer[] = [];
    const child = spawn(executable, [...args], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const finish = (result: Omit<CommandResult, "timedOut">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCommand({ ...result, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_COMMAND_STDOUT_BYTES) {
        outputTooLarge = true;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({ exitCode: null, signal: null, errorCode: safeErrorCode(error) });
    });
    child.once("close", (exitCode, signal) => {
      finish({
        exitCode,
        signal,
        ...(stdout.length === 0 ? {} : { stdout: Buffer.concat(stdout).toString("utf8") }),
        ...(outputTooLarge
          ? { errorCode: "command_output_too_large" }
          : timedOut
            ? { errorCode: "command_timeout" }
            : {}),
      });
    });
  });
}

function updateComponent(
  prior: WatchdogComponentState | undefined,
  probe: WatchdogProbeResult,
): WatchdogComponentState {
  if (probe.phase === "healthy" || probe.phase === "degraded") {
    return {
      consecutiveFailures: 0,
      recoveryAttempted: false,
      lastProbe: probe,
      ...(prior?.lastRecovery === undefined ? {} : { lastRecovery: prior.lastRecovery }),
    };
  }
  if (probe.phase === "blocked") {
    return {
      consecutiveFailures: prior?.consecutiveFailures ?? 0,
      recoveryAttempted: prior?.recoveryAttempted ?? false,
      lastProbe: probe,
      ...(prior?.lastRecovery === undefined ? {} : { lastRecovery: prior.lastRecovery }),
    };
  }
  return {
    consecutiveFailures: Math.min(Number.MAX_SAFE_INTEGER, (prior?.consecutiveFailures ?? 0) + 1),
    recoveryAttempted: prior?.recoveryAttempted ?? false,
    lastProbe: probe,
    ...(prior?.lastRecovery === undefined ? {} : { lastRecovery: prior.lastRecovery }),
  };
}

function nextRecoveryComponent(
  state: ServiceWatchdogState,
  failureThreshold: number,
): WatchdogComponent | undefined {
  for (const component of ["api", "web"] as const) {
    const value = state.components[component];
    if (
      value?.lastProbe.phase === "failed" &&
      value.consecutiveFailures >= failureThreshold &&
      !value.recoveryAttempted
    ) {
      return component;
    }
  }
  return undefined;
}

function overallPhase(
  components: ServiceWatchdogState["components"],
  webExpected: boolean,
): WatchdogPhase {
  if (components.api?.lastProbe.phase !== "healthy") return "degraded";
  if (webExpected && components.web?.lastProbe.phase !== "healthy") return "degraded";
  return "healthy";
}

function initialState(instance: string, now: Date): ServiceWatchdogState {
  return {
    schemaVersion: WATCHDOG_SCHEMA_VERSION,
    instance,
    phase: "degraded",
    updatedAt: now.toISOString(),
    components: {},
  };
}

function blockedProbe(
  component: WatchdogComponent,
  errorCode: string,
): WatchdogProbeResult {
  return { component, phase: "blocked", latencyMs: 0, errorCode };
}

function parseWatchdogState(value: unknown, instance: string): ServiceWatchdogState {
  if (!isRecord(value) || value.schemaVersion !== WATCHDOG_SCHEMA_VERSION || value.instance !== instance) {
    throw new Error("service watchdog state identity is invalid");
  }
  if (!["healthy", "degraded", "recovering"].includes(String(value.phase))) {
    throw new Error("service watchdog state phase is invalid");
  }
  if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error("service watchdog state timestamp is invalid");
  }
  if (!isRecord(value.components)) throw new Error("service watchdog component state is invalid");
  const components: ServiceWatchdogState["components"] = {};
  for (const component of ["api", "web"] as const) {
    const raw = value.components[component];
    if (raw === undefined) continue;
    components[component] = parseComponentState(raw, component);
  }
  return {
    schemaVersion: WATCHDOG_SCHEMA_VERSION,
    instance,
    phase: value.phase as WatchdogPhase,
    updatedAt: value.updatedAt,
    components,
  };
}

function parseComponentState(
  value: unknown,
  component: WatchdogComponent,
): WatchdogComponentState {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.consecutiveFailures) ||
    Number(value.consecutiveFailures) < 0 ||
    typeof value.recoveryAttempted !== "boolean"
  ) {
    throw new Error("service watchdog component counters are invalid");
  }
  const lastProbe = parseProbe(value.lastProbe, component);
  const lastRecovery = value.lastRecovery === undefined
    ? undefined
    : parseRecovery(value.lastRecovery);
  return {
    consecutiveFailures: Number(value.consecutiveFailures),
    recoveryAttempted: value.recoveryAttempted,
    lastProbe,
    ...(lastRecovery === undefined ? {} : { lastRecovery }),
  };
}

function parseProbe(value: unknown, component: WatchdogComponent): WatchdogProbeResult {
  if (
    !isRecord(value) ||
    value.component !== component ||
    !["healthy", "degraded", "failed", "blocked"].includes(String(value.phase)) ||
    typeof value.latencyMs !== "number" ||
    !Number.isFinite(value.latencyMs) ||
    value.latencyMs < 0
  ) {
    throw new Error("service watchdog probe state is invalid");
  }
  return {
    component,
    phase: value.phase as WatchdogProbePhase,
    latencyMs: value.latencyMs,
    ...(typeof value.statusCode === "number" ? { statusCode: value.statusCode } : {}),
    ...(typeof value.errorCode === "string" ? { errorCode: value.errorCode } : {}),
  };
}

function parseRecovery(
  value: unknown,
): WatchdogComponentState["lastRecovery"] {
  if (
    !isRecord(value) ||
    typeof value.ok !== "boolean" ||
    !["launchd", "systemd", "supervisord"].includes(String(value.supervisor)) ||
    typeof value.escalated !== "boolean" ||
    typeof value.durationMs !== "number" ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    typeof value.attemptedAt !== "string" ||
    !Number.isFinite(Date.parse(value.attemptedAt))
  ) {
    throw new Error("service watchdog recovery state is invalid");
  }
  return {
    ok: value.ok,
    supervisor: value.supervisor as WatchdogSupervisor,
    escalated: value.escalated,
    durationMs: value.durationMs,
    attemptedAt: value.attemptedAt,
    ...(typeof value.errorCode === "string" ? { errorCode: value.errorCode } : {}),
  };
}

function commandRecoveryResult(
  supervisor: WatchdogSupervisor,
  result: CommandResult,
  startedAt: number,
  escalated: boolean,
): WatchdogRecoveryResult {
  const ok = commandSucceeded(result);
  return {
    ok,
    supervisor,
    escalated,
    durationMs: elapsed(startedAt),
    ...(ok ? {} : { errorCode: result.errorCode ?? "supervisor_command_failed" }),
  };
}

function commandSucceeded(result: CommandResult): boolean {
  return !result.timedOut && result.exitCode === 0 && result.signal === null;
}

function serviceName(component: WatchdogComponent, instance: string): string {
  return component === "api" ? `pi-daemon-${instance}` : `pi-daemon-web-${instance}`;
}

function launchdLabel(component: WatchdogComponent, instance: string): string {
  return component === "api" ? `com.pi-daemon.${instance}` : `com.pi-daemon.web.${instance}`;
}

function validatedProbeUrl(raw: string): URL {
  if (raw.length === 0 || raw.length > 4096) throw new Error("probe URL is invalid");
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error("probe URL is invalid");
  }
  return url;
}

function validatedAuthority(raw: string): string {
  if (raw.length === 0 || raw.length > 512 || /[\s/@]/.test(raw)) {
    throw new Error("probe authority is invalid");
  }
  const parsed = new URL(`http://${raw}`);
  if (parsed.host !== raw || parsed.pathname !== "/") throw new Error("probe authority is invalid");
  return raw;
}

function authorityHostname(authority: string): string {
  return new URL(`http://${authority}`).hostname;
}

function assertTarget(target: WatchdogProbeTarget, expected: WatchdogComponent): void {
  if (target.component !== expected) throw new Error(`watchdog ${expected} target is invalid`);
  validatedProbeUrl(target.url);
  if (!Number.isInteger(target.expectedStatus) || target.expectedStatus < 100 || target.expectedStatus > 599) {
    throw new RangeError("expectedStatus must be an HTTP status code");
  }
  if (target.authority !== undefined) validatedAuthority(target.authority);
}

function assertInstance(instance: string): void {
  if (!INSTANCE_PATTERN.test(instance)) throw new Error("watchdog instance is invalid");
}

function safeErrorCode(error: NodeJS.ErrnoException): string {
  const code = error.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)
    ? code.toLowerCase()
    : "probe_failed";
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer`);
  return value;
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
