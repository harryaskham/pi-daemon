import { join, resolve } from "node:path";

import type {
  AgentSessionEvent,
  AgentSessionRuntime,
  RpcCommand,
  RpcResponse,
} from "@earendil-works/pi-coding-agent";

import { PI_RPC_COMMAND_TYPES } from "./session-api.js";

/** Exact Pi SDK release whose public runtime/RPC contract this build targets. */
export const PI_SDK_COMPATIBILITY_VERSION = "0.80.6" as const;

/** Session events required by daemon streaming and durable cursor adapters. */
export const PI_SESSION_EVENT_TYPES = [
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "entry_appended",
  "session_info_changed",
  "thinking_level_changed",
] as const satisfies readonly AgentSessionEvent["type"][];

type IsExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

export type PiRpcCommandContract = Assert<
  IsExact<RpcCommand["type"], (typeof PI_RPC_COMMAND_TYPES)[number]>
>;
export type PiSessionEventContract = Assert<
  IsExact<AgentSessionEvent["type"], (typeof PI_SESSION_EVENT_TYPES)[number]>
>;

/** Public replacement methods required by one hosted logical session. */
export type PiRuntimeReplacementContract = Pick<
  AgentSessionRuntime,
  "newSession" | "switchSession" | "fork" | "importFromJsonl" | "dispose"
>;

export type PiSdkRpcCommand = RpcCommand;
export type PiSdkRpcResponse = RpcResponse;

/** Sessions subdirectory stock Pi keeps below its agent directory. */
export const PI_SESSIONS_DIRECTORY_NAME = "sessions";

/**
 * Directory name stock Pi derives for a working directory when it stores a
 * session in its own home layout (`<agentDir>/sessions/--<encoded-cwd>--`).
 *
 * Pi 0.80.6 implements this encoding inside its internal `core/session-manager`
 * module as `getDefaultSessionDir()`. That helper is neither re-exported from
 * the package root nor reachable through the package `exports` map, and it
 * creates the directory with ambient permissions as a side effect, so the
 * daemon keeps this side-effect-free reproduction and derives owner-private
 * directories itself. `test/pi-sdk-compatibility.test.mjs` pins the encoding
 * against the real SDK through its public API and fails when either the
 * encoding or the exported surface drifts.
 *
 * Deliberate divergence: stock Pi normalizes `~` and `file://` inputs before
 * resolving. Daemon callers always supply canonical absolute paths, so this
 * helper only applies `path.resolve`, which is identical for absolute and
 * ordinary relative input.
 */
export function piDefaultSessionDirectoryName(cwd: string): string {
  const canonical = resolve(cwd);
  return `--${canonical.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Absolute stock-Pi session directory for `cwd` below an agent directory. */
export function piDefaultSessionDirectory(cwd: string, agentDir: string): string {
  return join(resolve(agentDir), PI_SESSIONS_DIRECTORY_NAME, piDefaultSessionDirectoryName(cwd));
}

/** Shape of stock Pi's own default-session-directory helper. */
export type PiDefaultSessionDirHelper = (cwd: string, agentDir?: string) => string;

/**
 * Pinned observation: the Pi 0.80.6 package root does not export
 * `getDefaultSessionDir`. When a supported release exports it, the pinned
 * compatibility test fails until this constant is updated, which is the signal
 * to consume the upstream helper through {@link piSdkDefaultSessionDirHelper}
 * instead of trusting the local reproduction alone. Upstream re-export of a
 * side-effect-free path helper remains the preferred fix.
 */
export const PI_SDK_EXPORTS_DEFAULT_SESSION_DIR = false;

/**
 * Resolve stock Pi's default-session-directory helper from an SDK module
 * namespace when a release starts exporting it. The namespace is injected so
 * this pinned contract module stays free of runtime SDK imports.
 */
export function piSdkDefaultSessionDirHelper(sdk: unknown): PiDefaultSessionDirHelper | undefined {
  if (typeof sdk !== "object" || sdk === null) return undefined;
  const candidate = (sdk as Record<string, unknown>)["getDefaultSessionDir"];
  return typeof candidate === "function" ? (candidate as PiDefaultSessionDirHelper) : undefined;
}
