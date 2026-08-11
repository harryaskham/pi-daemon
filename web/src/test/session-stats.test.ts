import { describe, expect, it } from "vitest";

import {
  contextPercentLabel,
  contextUsageFromSessionStats,
  liveContextLabel,
} from "../session-stats";

describe("Dashboard session context usage", () => {
  it("projects the pinned Pi stats shape and clamps display percentage", () => {
    expect(contextUsageFromSessionStats({
      contextUsage: { tokens: 250, contextWindow: 200, percent: 125 },
    })).toEqual({ tokens: 250, contextWindow: 200, percent: 100 });
    expect(contextUsageFromSessionStats({
      contextUsage: { tokens: 50, contextWindow: 200, percent: -2 },
    })).toEqual({ tokens: 50, contextWindow: 200, percent: 0 });
  });

  it("keeps unavailable and post-compaction unknown distinct from measured zero", () => {
    expect(contextUsageFromSessionStats(undefined)).toBeUndefined();
    expect(contextUsageFromSessionStats({ contextUsage: { tokens: 1, contextWindow: 0, percent: 1 } })).toBeUndefined();
    expect(contextUsageFromSessionStats({
      contextUsage: { tokens: null, contextWindow: 200_000, percent: 45 },
    })).toEqual({ tokens: null, contextWindow: 200_000, percent: null });
    expect(contextPercentLabel(null)).toBe("Unknown");
    expect(liveContextLabel(undefined, null)).toBe("context unknown");
    expect(liveContextLabel({
      contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
    }, 0)).toBe("context unknown");
  });

  it("prefers current live Pi usage over the inventory fallback", () => {
    expect(liveContextLabel({
      contextUsage: { tokens: 84_000, contextWindow: 200_000, percent: 42 },
    }, 7)).toBe("42% context");
  });
});
