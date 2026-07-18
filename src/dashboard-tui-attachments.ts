import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { DASHBOARD_TUI_SUBPROTOCOL } from "./session-api.js";

export interface DashboardTuiAttachmentManager {
  readonly available: boolean;
  attach(
    request: IncomingMessage,
    socket: Duplex,
    sessionRef: string,
    url: URL,
  ): Promise<void>;
}

/** Capability-gated placeholder until the injected InteractiveSessionView host lands. */
export class UnavailableDashboardTuiAttachments implements DashboardTuiAttachmentManager {
  readonly available = false;

  async attach(): Promise<void> {
    throw new DashboardTuiAttachmentError(
      501,
      "tui_unavailable",
      "server-side TUI channel is unavailable",
    );
  }
}

export class DashboardTuiAttachmentError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = "DashboardTuiAttachmentError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function dashboardTuiUpgradeHeaders(): Record<string, string> {
  return { "Sec-WebSocket-Protocol": DASHBOARD_TUI_SUBPROTOCOL };
}
