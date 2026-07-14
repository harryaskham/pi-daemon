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
