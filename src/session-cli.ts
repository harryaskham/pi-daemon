import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadClientBearer, runRpcStdioCli, type RpcStdioCliIo } from "./rpc-stdio-cli.js";
import { PiDaemonClient } from "./client.js";
import { encodeBoundedLine, type OpenPayload, type ProtocolCommand } from "./protocol.js";
import {
  SESSION_API_VERSION,
  type SessionResource,
  type SessionSpec,
  type TicketResource,
} from "./session-api.js";
import { SessionApiClient } from "./session-client.js";

export interface SessionCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface SessionCliDependencies {
  environment?: NodeJS.ProcessEnv;
  rpcIo?: RpcStdioCliIo;
  runRpcCli?: typeof runRpcStdioCli;
}

export class SessionCliUsageError extends Error {
  override readonly name = "SessionCliUsageError";
}

type OptionMap = Map<string, string>;

type SessionTarget =
  | { kind: "unix"; socketPath: string; timeoutMs: number }
  | { kind: "api"; client: SessionApiClient; timeoutMs: number };

const COMMON_OPTIONS = [
  "socket",
  "url",
  "token-file",
  "token-fd",
  "allow-insecure-http",
  "timeout-ms",
] as const;

export async function runHighLevelCli(
  command: string,
  args: string[],
  io: SessionCliIo,
  dependencies: SessionCliDependencies = {},
): Promise<number> {
  switch (command) {
    case "session":
      return runSession(args, io, dependencies);
    case "ticket":
      return runTicket(args, io, dependencies);
    case "prompt":
      return runPrompt(args, io, dependencies);
    case "control":
      return runControl(args, io, dependencies);
    case "rpc":
      return runRpc(args, io, dependencies);
    case "acp":
      return runAcp(args, io, dependencies);
    default:
      throw new SessionCliUsageError(`unknown high-level command: ${command}`);
  }
}

async function runSession(
  args: string[],
  io: SessionCliIo,
  dependencies: SessionCliDependencies,
): Promise<number> {
  const [action, ...rest] = args;
  switch (action) {
    case "list": {
      const options = parseOptions(rest, [...COMMON_OPTIONS, "limit", "cursor"]);
      const target = apiTarget(options, dependencies);
      const result = await target.client.list(
        optionalInteger(options, "limit", 1) ?? 50,
        options.get("cursor"),
      );
      print(io, result.data);
      return 0;
    }
    case "show": {
      const options = parseOptions(rest, [...COMMON_OPTIONS, "session", "generation"]);
      const sessionRef = required(options, "session");
      const target = await targetFrom(options, dependencies);
      if (target.kind === "api") {
        print(io, (await target.client.getSession(sessionRef)).data);
      } else {
        const client = await unixClient(target);
        try {
          print(
            io,
            (
              await client.request({
                protocolVersion: "1.0",
                requestId: requestId(),
                operation: "status",
                sessionId: sessionRef,
                payload: {},
              })
            ).data,
          );
        } finally {
          client.close();
        }
      }
      return 0;
    }
    case "create":
    case "update": {
      const options = parseOptions(rest, [
        ...COMMON_OPTIONS,
        "session",
        "generation",
        "revision",
        "request-id",
        "idempotency-key",
        "wait",
        "spec-file",
        "spec-json",
        "cwd",
        "name",
        "agent-dir",
        "target",
        "session-path",
        "provider",
        "model",
        "thinking",
        "tools",
        "include-tools",
        "exclude-tools",
        "system-prompt",
      ]);
      const spec = await sessionSpec(options);
      const target = await targetFrom(options, dependencies);
      const sessionRef = options.get("session");
      const generation =
        action === "update"
          ? requiredInteger(options, "generation", 0)
          : (optionalInteger(options, "generation", 0) ?? 1);
      if (target.kind === "unix") {
        if (sessionRef === undefined) {
          throw new SessionCliUsageError("--session is required for Unix create/update");
        }
        const client = await unixClient(target);
        try {
          print(
            io,
            await client.request({
              protocolVersion: "1.0",
              requestId: options.get("request-id") ?? requestId(),
              operation: "open",
              sessionId: sessionRef,
              generation,
              payload: legacyOpenPayload(spec),
            }),
          );
        } finally {
          client.close();
        }
        return 0;
      }
      const request = options.get("request-id") ?? requestId();
      const idempotencyKey = options.get("idempotency-key") ?? randomUUID();
      const wait = booleanOption(options, "wait", false);
      if (action === "create") {
        const result = await target.client.request<TicketResource>(
          "POST",
          `/v1/session?waitForTerminal=${wait}`,
          {
            body: {
              requestId: request,
              ...(sessionRef === undefined ? {} : { sessionId: sessionRef }),
              spec,
            },
            headers: { "Idempotency-Key": idempotencyKey },
          },
        );
        print(io, result.data);
        return wait ? ticketExitCode(result.data) : 0;
      }
      if (sessionRef === undefined) throw new SessionCliUsageError("--session is required for update");
      const revision = requiredInteger(options, "revision", 1);
      const currentGeneration = requiredInteger(options, "generation", 0);
      const current = await checkedSession(target.client, sessionRef, currentGeneration, revision);
      const result = await target.client.request<TicketResource>(
        "PUT",
        `/v1/session/${encodeURIComponent(sessionRef)}?waitForTerminal=${wait}`,
        {
          body: {
            requestId: request,
            expectedGeneration: currentGeneration,
            expectedRevision: revision,
            spec,
          },
          headers: {
            "Idempotency-Key": idempotencyKey,
            "If-Match": requiredEtag(current),
          },
        },
      );
      print(io, result.data);
      return wait ? ticketExitCode(result.data) : 0;
    }
    case "delete": {
      const options = parseOptions(rest, [
        ...COMMON_OPTIONS,
        "session",
        "generation",
        "revision",
        "request-id",
        "idempotency-key",
        "retain",
        "wait",
      ]);
      const sessionRef = required(options, "session");
      const generation = requiredInteger(options, "generation", 0);
      const target = await targetFrom(options, dependencies);
      const retain = booleanOption(options, "retain", true);
      if (target.kind === "unix") {
        const client = await unixClient(target);
        try {
          print(
            io,
            await client.request({
              protocolVersion: "1.0",
              requestId: options.get("request-id") ?? requestId(),
              operation: "close",
              sessionId: sessionRef,
              generation,
              payload: { retainSession: retain },
            }),
          );
        } finally {
          client.close();
        }
        return 0;
      }
      const revision = requiredInteger(options, "revision", 1);
      const current = await checkedSession(target.client, sessionRef, generation, revision);
      const wait = booleanOption(options, "wait", false);
      const result = await target.client.request<TicketResource>(
        "DELETE",
        `/v1/session/${encodeURIComponent(sessionRef)}?retainArtifacts=${retain}&waitForTerminal=${wait}`,
        {
          headers: {
            "Idempotency-Key": options.get("idempotency-key") ?? randomUUID(),
            "If-Match": requiredEtag(current),
            "X-Request-Id": options.get("request-id") ?? requestId(),
          },
        },
      );
      print(io, result.data);
      return wait ? ticketExitCode(result.data) : 0;
    }
    default:
      throw new SessionCliUsageError("session action must be list, show, create, update, or delete");
  }
}

async function runTicket(
  args: string[],
  io: SessionCliIo,
  dependencies: SessionCliDependencies,
): Promise<number> {
  const [action, ...rest] = args;
  const options = parseOptions(rest, [
    ...COMMON_OPTIONS,
    "ticket",
    "poll-ms",
    "request-id",
    "state",
    "pi-entry-ids",
    "error-code",
    "error-message",
    "retryable",
  ]);
  const target = apiTarget(options, dependencies);
  const ticketId = required(options, "ticket");
  if (action === "get") {
    print(io, (await target.client.getTicket(ticketId)).data);
    return 0;
  }
  if (action === "wait") {
    const result = await target.client.waitTicket(ticketId, {
      timeoutMs: target.timeoutMs,
      ...(options.has("poll-ms")
        ? { pollMs: requiredInteger(options, "poll-ms", 1) }
        : {}),
    });
    print(io, result.data);
    return ticketExitCode(result.data);
  }
  if (action === "reconcile") {
    const state = required(options, "state");
    if (state !== "succeeded" && state !== "failed") {
      throw new SessionCliUsageError("--state must be succeeded or failed");
    }
    const piEntryIds = csv(required(options, "pi-entry-ids"));
    if (piEntryIds.length === 0 || piEntryIds.length > 256) {
      throw new SessionCliUsageError("--pi-entry-ids must contain 1 to 256 IDs");
    }
    const body = {
      requestId: options.get("request-id") ?? requestId(),
      state,
      evidence: { piEntryIds },
      ...(state === "failed"
        ? {
            error: {
              code: required(options, "error-code"),
              message: required(options, "error-message"),
              retryable: booleanOption(options, "retryable", false),
            },
          }
        : {}),
    };
    print(
      io,
      (
        await target.client.request<TicketResource>(
          "POST",
          `/v1/ticket/${encodeURIComponent(ticketId)}/reconcile`,
          { body },
        )
      ).data,
    );
    return 0;
  }
  throw new SessionCliUsageError("ticket action must be get, wait, or reconcile");
}

async function runPrompt(
  args: string[],
  io: SessionCliIo,
  dependencies: SessionCliDependencies,
): Promise<number> {
  const options = parseOptions(args, [
    ...COMMON_OPTIONS,
    "session",
    "generation",
    "message",
    "request-id",
    "idempotency-key",
    "source",
  ]);
  const sessionRef = required(options, "session");
  const message = required(options, "message");
  const generation = requiredInteger(options, "generation", 0);
  const target = await targetFrom(options, dependencies);
  if (target.kind === "api") {
    const result = await target.client.rpcCommand(
      sessionRef,
      { id: options.get("request-id") ?? requestId(), type: "prompt", message },
      { timeoutMs: target.timeoutMs, waitForSettled: true, generation },
    );
    print(io, result);
    return result.response.success ? 0 : 1;
  }
  const client = await unixClient(target);
  try {
    print(
      io,
      await client.request({
        protocolVersion: "1.0",
        requestId: options.get("request-id") ?? requestId(),
        operation: "wake",
        sessionId: sessionRef,
        generation,
        idempotencyKey: options.get("idempotency-key") ?? randomUUID(),
        payload: {
          prompt: message,
          ...(options.get("source") === undefined ? {} : { source: options.get("source") }),
        },
      }),
    );
    return 0;
  } finally {
    client.close();
  }
}

async function runControl(
  args: string[],
  io: SessionCliIo,
  dependencies: SessionCliDependencies,
): Promise<number> {
  const [action, ...rest] = args;
  if (action !== "steer" && action !== "follow-up" && action !== "abort") {
    throw new SessionCliUsageError("control action must be steer, follow-up, or abort");
  }
  const options = parseOptions(rest, [
    ...COMMON_OPTIONS,
    "session",
    "generation",
    "message",
    "request-id",
    "idempotency-key",
  ]);
  const sessionRef = required(options, "session");
  const generation = requiredInteger(options, "generation", 0);
  const target = await targetFrom(options, dependencies);
  const rpcType = action === "follow-up" ? "follow_up" : action;
  if (target.kind === "api") {
    const result = await target.client.rpcCommand(
      sessionRef,
      {
        id: options.get("request-id") ?? requestId(),
        type: rpcType,
        ...(action === "abort" ? {} : { message: required(options, "message") }),
      },
      { timeoutMs: target.timeoutMs, generation },
    );
    print(io, result);
    return result.response.success ? 0 : 1;
  }
  const client = await unixClient(target);
  try {
    const command: ProtocolCommand =
      action === "abort"
        ? {
            protocolVersion: "1.0",
            requestId: options.get("request-id") ?? requestId(),
            operation: "abort",
            sessionId: sessionRef,
            generation,
            payload: {},
          }
        : {
            protocolVersion: "1.0",
            requestId: options.get("request-id") ?? requestId(),
            operation: action === "steer" ? "steer" : "followUp",
            sessionId: sessionRef,
            generation,
            idempotencyKey: options.get("idempotency-key") ?? randomUUID(),
            payload: { message: required(options, "message") },
          };
    print(io, await client.request(command));
    return 0;
  } finally {
    client.close();
  }
}

async function runRpc(
  args: string[],
  io: SessionCliIo,
  dependencies: SessionCliDependencies,
): Promise<number> {
  const [action, ...rest] = args;
  if (action === "attach") {
    const runner = dependencies.runRpcCli ?? runRpcStdioCli;
    const rpcIo = dependencies.rpcIo ?? {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      environment: dependencies.environment ?? process.env,
    };
    return runner(rest, rpcIo);
  }
  if (action === "discover") return runDiscovery("rpc", rest, io, dependencies);
  throw new SessionCliUsageError("rpc action must be attach or discover");
}

async function runAcp(
  args: string[],
  io: SessionCliIo,
  dependencies: SessionCliDependencies,
): Promise<number> {
  const [action, ...rest] = args;
  if (action !== "discover") throw new SessionCliUsageError("acp action must be discover");
  return runDiscovery("apc", rest, io, dependencies);
}

async function runDiscovery(
  kind: "rpc" | "apc",
  args: string[],
  io: SessionCliIo,
  dependencies: SessionCliDependencies,
): Promise<number> {
  const options = parseOptions(args, [...COMMON_OPTIONS, "session", "role"]);
  const target = apiTarget(options, dependencies);
  const sessionRef = required(options, "session");
  const resource = (await target.client.getSession(sessionRef)).data;
  const link = kind === "rpc" ? resource.links.rpc : resource.links.apc;
  const url = new URL(link, target.client.baseUrl);
  url.protocol = target.client.baseUrl.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("generation", String(resource.generation));
  if (kind === "rpc") url.searchParams.set("role", options.get("role") ?? "controller");
  print(io, {
    protocol: kind === "rpc" ? "Pi RPC" : "ACP",
    subprotocol: kind === "rpc" ? "pi-daemon-rpc.v1" : "agent-client-protocol.v1",
    sessionId: resource.sessionId,
    generation: resource.generation,
    residency: resource.residency,
    url: url.href,
    bearerRequired: true,
  });
  return 0;
}

async function targetFrom(
  options: OptionMap,
  dependencies: SessionCliDependencies,
): Promise<SessionTarget> {
  const socketPath = options.get("socket");
  const timeoutMs = optionalInteger(options, "timeout-ms", 1) ?? 30_000;
  if (socketPath !== undefined) {
    if (options.has("url") || hasTokenOptions(options)) {
      throw new SessionCliUsageError("--socket cannot be combined with API URL/token options");
    }
    return { kind: "unix", socketPath, timeoutMs };
  }
  return apiTarget(options, dependencies);
}

function apiTarget(
  options: OptionMap,
  dependencies: SessionCliDependencies,
): Extract<SessionTarget, { kind: "api" }> {
  if (options.has("socket")) throw new SessionCliUsageError("this command requires --url, not --socket");
  const timeoutMs = optionalInteger(options, "timeout-ms", 1) ?? 30_000;
  const tokenFile = options.get("token-file");
  const tokenFd = optionalInteger(options, "token-fd", 3);
  const token = loadClientBearer({
    environment: dependencies.environment ?? process.env,
    ...(tokenFile === undefined ? {} : { tokenFile: resolve(tokenFile) }),
    ...(tokenFd === undefined ? {} : { tokenFd }),
  });
  return {
    kind: "api",
    timeoutMs,
    client: new SessionApiClient({
      baseUrl: options.get("url") ?? "http://127.0.0.1:7463",
      bearerToken: token,
      timeoutMs,
      allowInsecureRemote: booleanOption(options, "allow-insecure-http", false),
    }),
  };
}

async function unixClient(target: Extract<SessionTarget, { kind: "unix" }>): Promise<PiDaemonClient> {
  return PiDaemonClient.connect({
    socketPath: target.socketPath,
    connectTimeoutMs: Math.min(5_000, target.timeoutMs),
    requestTimeoutMs: target.timeoutMs,
  });
}

async function checkedSession(
  client: SessionApiClient,
  sessionRef: string,
  generation: number,
  revision: number,
): Promise<{ resource: SessionResource; etag: string | string[] | undefined }> {
  const result = await client.getSession(sessionRef);
  if (result.data.generation !== generation || result.data.revision !== revision) {
    throw new SessionCliUsageError("session generation/revision changed");
  }
  return { resource: result.data, etag: result.headers.etag };
}

function requiredEtag(value: { etag: string | string[] | undefined }): string {
  if (typeof value.etag !== "string") throw new Error("session API omitted ETag");
  return value.etag;
}

async function sessionSpec(options: OptionMap): Promise<SessionSpec> {
  const specFile = options.get("spec-file");
  const specJson = options.get("spec-json");
  if (specFile !== undefined && specJson !== undefined) {
    throw new SessionCliUsageError("use only one of --spec-file or --spec-json");
  }
  if (specFile !== undefined) {
    const path = resolve(specFile);
    const info = await lstat(path);
    const getuid = process.getuid;
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      (getuid !== undefined && info.uid !== getuid()) ||
      (info.mode & 0o077) !== 0 ||
      info.size > 1024 * 1024
    ) {
      throw new SessionCliUsageError(
        "--spec-file must be an owner-only bounded regular non-symlink file",
      );
    }
    return validateSpec(parseJson(await readFile(path, "utf8"), "--spec-file"));
  }
  if (specJson !== undefined) {
    if (Buffer.byteLength(specJson, "utf8") > 1024 * 1024) {
      throw new SessionCliUsageError("--spec-json exceeds byte limit");
    }
    const value = validateSpec(parseJson(specJson, "--spec-json"));
    if (value.env !== undefined) {
      throw new SessionCliUsageError("raw env values are refused in --spec-json; use an owner-only --spec-file");
    }
    return value;
  }
  const cwd = resolve(required(options, "cwd"));
  const targetMode = options.get("target") ?? "new";
  if (!["new", "continue", "open", "memory"].includes(targetMode)) {
    throw new SessionCliUsageError("--target must be new, continue, open, or memory");
  }
  const target: SessionSpec["target"] = { mode: targetMode as "new" | "continue" | "open" | "memory" };
  if (targetMode === "open") target.path = required(options, "session-path");
  const provider = options.get("provider");
  const model = options.get("model");
  if ((provider === undefined) !== (model === undefined)) {
    throw new SessionCliUsageError("--provider and --model must be supplied together");
  }
  const spec: SessionSpec = {
    cwd,
    target,
    isolation: { mode: "unisolated" },
  };
  const name = options.get("name");
  const agentDir = options.get("agent-dir");
  if (name !== undefined) spec.name = name;
  if (agentDir !== undefined) spec.agentDir = resolve(agentDir);
  if (provider !== undefined && model !== undefined) {
    const thinking = options.get("thinking");
    spec.model = {
      provider,
      id: model,
      ...(thinking === undefined ? {} : { thinkingLevel: thinkingLevel(thinking) }),
    };
  }
  if (options.has("tools") || options.has("include-tools") || options.has("exclude-tools")) {
    const mode = options.get("tools") ?? "default";
    if (!["default", "none", "no-builtin", "allowlist"].includes(mode)) {
      throw new SessionCliUsageError("--tools is invalid");
    }
    const include = csv(options.get("include-tools"));
    const exclude = csv(options.get("exclude-tools"));
    spec.tools = {
      mode: mode as "default" | "none" | "no-builtin" | "allowlist",
      ...(include.length === 0 ? {} : { include }),
      ...(exclude.length === 0 ? {} : { exclude }),
    };
  }
  const systemPrompt = options.get("system-prompt");
  if (systemPrompt !== undefined) {
    spec.resources = { systemPrompt };
  }
  return spec;
}

function legacyOpenPayload(spec: SessionSpec): OpenPayload {
  if (spec.target.mode === "fork") {
    throw new SessionCliUsageError("Unix compatibility open does not support fork targets");
  }
  if (spec.tools !== undefined && spec.tools.mode !== undefined && spec.tools.mode !== "none") {
    throw new SessionCliUsageError("Unix compatibility open supports only no-tools policy");
  }
  if (
    spec.model !== undefined &&
    (typeof spec.model.provider !== "string" || typeof spec.model.id !== "string")
  ) {
    throw new SessionCliUsageError("Unix model policy requires provider and id");
  }
  return {
    cwd: spec.cwd,
    ...(spec.name === undefined ? {} : { name: spec.name }),
    ...(spec.agentDir === undefined ? {} : { agentDir: spec.agentDir }),
    session: {
      mode: spec.target.mode,
      ...(spec.target.path === undefined ? {} : { path: spec.target.path }),
    },
    ...(spec.model === undefined
      ? {}
      : {
          model: {
            provider: spec.model.provider!,
            id: spec.model.id!,
            ...(spec.model.thinkingLevel === undefined
              ? {}
              : { thinkingLevel: spec.model.thinkingLevel }),
          },
        }),
    resources: {
      extensions: "none",
      skills: "none",
      promptTemplates: "none",
      themes: "none",
      contextFiles: "none",
      tools: "none",
      ...(spec.resources?.systemPrompt === undefined
        ? {}
        : { systemPrompt: spec.resources.systemPrompt }),
    },
  };
}

function validateSpec(value: unknown): SessionSpec {
  if (!isRecord(value) || typeof value.cwd !== "string" || !isRecord(value.target)) {
    throw new SessionCliUsageError("session spec must contain cwd and target");
  }
  if (typeof value.target.mode !== "string") {
    throw new SessionCliUsageError("session spec target.mode is required");
  }
  return value as unknown as SessionSpec;
}

function parseOptions(args: string[], allowed: readonly string[]): OptionMap {
  const allowedSet = new Set(allowed);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--") || token.length <= 2) {
      throw new SessionCliUsageError(`unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    if (!allowedSet.has(name)) throw new SessionCliUsageError(`unknown option: --${name}`);
    if (options.has(name)) throw new SessionCliUsageError(`duplicate option: --${name}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new SessionCliUsageError(`option --${name} requires a value`);
    }
    options.set(name, value);
    index += 1;
  }
  return options;
}

function required(options: OptionMap, name: string): string {
  const value = options.get(name);
  if (value === undefined || value.length === 0) throw new SessionCliUsageError(`missing --${name}`);
  return value;
}

function requiredInteger(options: OptionMap, name: string, minimum: number): number {
  const value = optionalInteger(options, name, minimum);
  if (value === undefined) throw new SessionCliUsageError(`missing --${name}`);
  return value;
}

function optionalInteger(options: OptionMap, name: string, minimum: number): number | undefined {
  const raw = options.get(name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new SessionCliUsageError(`--${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new SessionCliUsageError(`--${name} must be at least ${minimum}`);
  }
  return value;
}

function booleanOption(options: OptionMap, name: string, fallback: boolean): boolean {
  const raw = options.get(name);
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new SessionCliUsageError(`--${name} must be true or false`);
}

function hasTokenOptions(options: OptionMap): boolean {
  return options.has("token-file") || options.has("token-fd") || options.has("allow-insecure-http");
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new SessionCliUsageError(`${label} must contain valid JSON`);
  }
}

function thinkingLevel(
  value: string,
): NonNullable<NonNullable<SessionSpec["model"]>["thinkingLevel"]> {
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) {
    throw new SessionCliUsageError("--thinking is invalid");
  }
  return value as NonNullable<NonNullable<SessionSpec["model"]>["thinkingLevel"]>;
}

function csv(value: string | undefined): string[] {
  return value === undefined
    ? []
    : value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function ticketExitCode(ticket: TicketResource): number {
  if (ticket.state === "failed") return 1;
  if (ticket.state === "indeterminate") return 75;
  return 0;
}

function requestId(): string {
  return `cli-${randomUUID()}`;
}

function print(io: SessionCliIo, value: unknown): void {
  io.stdout(
    encodeBoundedLine(
      { apiVersion: SESSION_API_VERSION, data: value },
      4 * 1024 * 1024,
    ).toString("utf8"),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
