#!/usr/bin/env node
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_RPC_STDIO_BRIDGE_LIMITS,
  RpcStdioBridge,
  type RpcStdioBridgeOptions,
} from "./rpc-bridge.js";

const VERSION = "0.1.0";
const TOKEN_ENV = "PI_DAEMON_BEARER_TOKEN";
const MIN_TOKEN_BYTES = 16;
const MAX_TOKEN_BYTES = 4096;

export interface RpcStdioCliIo {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  environment?: NodeJS.ProcessEnv;
}

export interface RpcStdioCliDependencies {
  createBridge?: (options: RpcStdioBridgeOptions) => RpcStdioBridge;
}

interface ParsedRpcStdioArgs {
  help: boolean;
  version: boolean;
  baseUrl: string;
  sessionRef?: string;
  role: "controller" | "observer";
  allowInsecureRemote: boolean;
  tokenFile?: string;
  tokenFd?: number;
  reconnectAttempts: number;
  connectTimeoutMs: number;
  terminalDrainTimeoutMs: number;
}

export async function runRpcStdioCli(
  args: string[],
  io: RpcStdioCliIo = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
  dependencies: RpcStdioCliDependencies = {},
): Promise<number> {
  try {
    const parsed = parseArgs(args);
    if (parsed.help) {
      io.stdout.write(helpText());
      return 0;
    }
    if (parsed.version) {
      io.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (parsed.sessionRef === undefined) throw new Error("--session is required");
    const token = loadClientBearer({
      environment: io.environment ?? process.env,
      ...(parsed.tokenFile === undefined ? {} : { tokenFile: parsed.tokenFile }),
      ...(parsed.tokenFd === undefined ? {} : { tokenFd: parsed.tokenFd }),
    });
    const createBridge = dependencies.createBridge ?? ((options) => new RpcStdioBridge(options));
    const bridge = createBridge({
      baseUrl: parsed.baseUrl,
      sessionRef: parsed.sessionRef,
      bearerToken: token,
      input: io.stdin,
      output: io.stdout,
      statusOutput: io.stderr,
      role: parsed.role,
      allowInsecureRemote: parsed.allowInsecureRemote,
      limits: {
        reconnectAttempts: parsed.reconnectAttempts,
        connectTimeoutMs: parsed.connectTimeoutMs,
        terminalDrainTimeoutMs: parsed.terminalDrainTimeoutMs,
      },
    });
    const onSignal = (): void => bridge.stop();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      const result = await bridge.run();
      return result.code;
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  } catch (error) {
    io.stderr.write(
      `${JSON.stringify({
        type: "pi_daemon_rpc_status",
        event: "fatal",
        message: safeCliError(error),
      })}\n`,
    );
    return 1;
  }
}

function parseArgs(args: string[]): ParsedRpcStdioArgs {
  const parsed: ParsedRpcStdioArgs = {
    help: false,
    version: false,
    baseUrl: "http://127.0.0.1:7463",
    role: "controller",
    allowInsecureRemote: false,
    reconnectAttempts: DEFAULT_RPC_STDIO_BRIDGE_LIMITS.reconnectAttempts,
    connectTimeoutMs: DEFAULT_RPC_STDIO_BRIDGE_LIMITS.connectTimeoutMs,
    terminalDrainTimeoutMs: DEFAULT_RPC_STDIO_BRIDGE_LIMITS.terminalDrainTimeoutMs,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const next = (): string => {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--version":
      case "-V":
        parsed.version = true;
        break;
      case "--url":
        parsed.baseUrl = next();
        break;
      case "--session":
        parsed.sessionRef = next();
        break;
      case "--role": {
        const role = next();
        if (role !== "controller" && role !== "observer") {
          throw new Error("--role must be controller or observer");
        }
        parsed.role = role;
        break;
      }
      case "--allow-insecure-http":
        parsed.allowInsecureRemote = true;
        break;
      case "--token-file":
        parsed.tokenFile = next();
        break;
      case "--token-fd":
        parsed.tokenFd = integer(next(), "--token-fd", 3);
        break;
      case "--reconnect-attempts":
        parsed.reconnectAttempts = integer(next(), "--reconnect-attempts", 1);
        break;
      case "--connect-timeout-ms":
        parsed.connectTimeoutMs = integer(next(), "--connect-timeout-ms", 1);
        break;
      case "--terminal-timeout-ms":
        parsed.terminalDrainTimeoutMs = integer(next(), "--terminal-timeout-ms", 1);
        break;
      default:
        throw new Error("unknown option");
    }
  }
  return parsed;
}

function loadClientBearer(options: {
  tokenFile?: string;
  tokenFd?: number;
  environment: NodeJS.ProcessEnv;
}): string {
  const environmentToken = options.environment[TOKEN_ENV];
  const sources = [
    options.tokenFile === undefined ? undefined : "file",
    options.tokenFd === undefined ? undefined : "fd",
    environmentToken === undefined ? undefined : "environment",
  ].filter((source): source is "file" | "fd" | "environment" => source !== undefined);
  if (sources.length !== 1) {
    throw new Error(
      sources.length === 0
        ? `exactly one bearer source is required: --token-file, --token-fd, or ${TOKEN_ENV}`
        : "bearer sources are mutually exclusive",
    );
  }
  let raw = "";
  switch (sources[0]) {
    case "file":
      raw = readPrivateTokenFile(options.tokenFile!);
      break;
    case "fd":
      raw = readBoundedFd(options.tokenFd!, false);
      break;
    case "environment":
      raw = environmentToken!;
      break;
  }
  const token = stripOneLineEnding(raw);
  const bytes = Buffer.byteLength(token, "utf8");
  if (bytes < MIN_TOKEN_BYTES || bytes > MAX_TOKEN_BYTES) {
    throw new Error(`bearer token must be between ${MIN_TOKEN_BYTES} and ${MAX_TOKEN_BYTES} UTF-8 bytes`);
  }
  if (!/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) {
    throw new Error("bearer token is unsafe for an HTTP Authorization header");
  }
  return token;
}

function readPrivateTokenFile(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new Error("bearer token file must be a regular non-symlink file");
    }
    throw new Error("unable to open bearer token file");
  }
  try {
    return readBoundedFd(fd, true);
  } finally {
    closeSync(fd);
  }
}

function readBoundedFd(fd: number, requirePrivate: boolean): string {
  if (!Number.isSafeInteger(fd) || fd < 3) {
    throw new Error("token descriptor must be an inherited descriptor of at least 3");
  }
  const info = fstatSync(fd);
  if (!info.isFile()) throw new Error("bearer source must be a regular file");
  if (requirePrivate) {
    const getuid = process.getuid;
    if (getuid !== undefined && info.uid !== getuid()) {
      throw new Error("bearer token file must be owned by the current user");
    }
    if ((info.mode & 0o077) !== 0) throw new Error("bearer token file must be owner-only");
  }
  if (info.size > MAX_TOKEN_BYTES + 2) throw new Error("bearer token source exceeds byte limit");
  return readFileSync(fd, "utf8");
}

function stripOneLineEnding(value: string): string {
  return value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
}

function integer(value: string, name: string, minimum: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum) {
    throw new Error(`${name} must be at least ${minimum}`);
  }
  return result;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function safeCliError(error: unknown): string {
  if (!(error instanceof Error)) return "RPC bridge failed";
  const allowed = [
    /^--/,
    /^unknown option$/,
    /^exactly one bearer source/,
    /^bearer sources/,
    /^bearer token/,
    /^token descriptor/,
    /^unable to open bearer/,
  ];
  return allowed.some((pattern) => pattern.test(error.message))
    ? error.message
    : "RPC bridge failed safely";
}

function helpText(): string {
  return `Usage: pi-daemon-rpc --session ID_OR_EXACT_NAME [options]

Bridge stock Pi RPC JSONL on stdin/stdout to one authenticated daemon session.
Daemon attach/reconnect/gap status is emitted as JSONL on stderr.

Options:
  --url URL                   API base URL (default http://127.0.0.1:7463)
  --session ID_OR_EXACT_NAME  Required exact daemon session reference
  --role controller|observer  Attachment role (default controller)
  --allow-insecure-http       Permit bearer over non-loopback plaintext HTTP
  --token-file PATH           Owner-only bearer file
  --token-fd FD               Inherited bearer descriptor (FD >= 3)
  --reconnect-attempts N      Consecutive reconnect limit (default 8)
  --connect-timeout-ms N      WebSocket handshake timeout (default 10000)
  --terminal-timeout-ms N     Stdin-EOF response deadline (default 300000)
  -h, --help                  Show help
  -V, --version               Show version

If file/fd is omitted, ${TOKEN_ENV} is used. Exactly one source is required.
Bearer values are never accepted as command-line arguments or written to output.
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
  process.exitCode = await runRpcStdioCli(process.argv.slice(2));
}
