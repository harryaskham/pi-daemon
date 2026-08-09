import type { JsonValue } from "@harryaskham/pi-daemon/session-api";

export interface LiveContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** Parse only the bounded public context fields projected by Pi Daemon RPC. */
export function contextUsageFromSessionStats(
  stats: JsonValue | undefined,
): LiveContextUsage | undefined {
  if (!isRecord(stats) || !isRecord(stats.contextUsage)) return undefined;
  const usage = stats.contextUsage;
  const contextWindow = usage.contextWindow;
  if (
    typeof contextWindow !== "number" ||
    !Number.isSafeInteger(contextWindow) ||
    contextWindow < 1
  ) {
    return undefined;
  }
  const tokens =
    usage.tokens !== null && typeof usage.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens >= 0
      ? usage.tokens
      : null;
  const percent =
    tokens !== null &&
    usage.percent !== null &&
    typeof usage.percent === "number" &&
    Number.isFinite(usage.percent)
      ? Math.min(100, Math.max(0, usage.percent))
      : null;
  return { tokens, contextWindow, percent };
}

export function contextPercentLabel(percent: number | null): string {
  return percent === null ? "Unknown" : `${Math.round(percent)}%`;
}

export function liveContextLabel(
  stats: JsonValue | undefined,
  fallbackPercent: number | null,
): string {
  const usage = contextUsageFromSessionStats(stats);
  const percent = usage === undefined ? fallbackPercent : usage.percent;
  return percent === null ? "context unknown" : `${Math.round(percent)}% context`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
