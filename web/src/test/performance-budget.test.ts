import { describe, expect, it, vi } from "vitest";
import {
  PERFORMANCE_BUDGET_ENV,
  enforcePerformanceBudgets,
  performanceBudgetOutcome,
  reportPerformanceBudget,
} from "./performance-budget";

describe("web performance budgets", () => {
  const marker = enforcePerformanceBudgets ? "[enforced]" : "[not enforced]";
  it("shares the repository-wide opt-in switch", () => {
    expect(PERFORMANCE_BUDGET_ENV).toBe("PI_DAEMON_PERFORMANCE_BUDGETS");
    expect(enforcePerformanceBudgets).toBe(process.env[PERFORMANCE_BUDGET_ENV] === "1");
  });

  it("reports an over-budget measurement without failing an unenforced run", () => {
    const outcome = performanceBudgetOutcome("probe", 617.4, 250, false);
    expect(outcome.within).toBe(false);
    expect(outcome.enforced).toBe(false);
    expect(outcome.failure).toBeUndefined();
    expect(outcome.summary).toBe("probe: 617.40ms (budget 250ms) OVER [not enforced]");
  });

  it("fails an over-budget measurement only when enforcement is requested", () => {
    const outcome = performanceBudgetOutcome("probe", 617.4, 250, true);
    expect(outcome.within).toBe(false);
    expect(outcome.failure).toBe("probe 617.40ms exceeded its 250ms budget");
    expect(outcome.summary).toBe("probe: 617.40ms (budget 250ms) OVER [enforced]");
  });

  it("keeps a within-budget measurement visible and passing under both modes", () => {
    for (const enforce of [false, true]) {
      const outcome = performanceBudgetOutcome("probe", 12.5, 16, enforce);
      expect(outcome.within).toBe(true);
      expect(outcome.failure).toBeUndefined();
      expect(outcome.summary).toContain("12.50ms (budget 16ms)");
      expect(outcome.summary).not.toContain("OVER");
    }
  });

  it("never throws from the reporter for a measurement inside its budget", () => {
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      expect(() => reportPerformanceBudget("probe", 1, 1_000)).not.toThrow();
    } finally {
      stderr.mockRestore();
    }
    expect(written).toEqual([`performance-budget probe: 1.00ms (budget 1000ms) ${marker}\n`]);
  });

  it("keeps an over-budget measurement visible when enforcement is off", () => {
    if (enforcePerformanceBudgets) return;
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      expect(() => reportPerformanceBudget("probe", 617.4, 250)).not.toThrow();
    } finally {
      stderr.mockRestore();
    }
    expect(written).toEqual([
      "performance-budget probe: 617.40ms (budget 250ms) OVER [not enforced]\n",
    ]);
  });

  it("fails the reporter for an over-budget measurement when enforcement is on", () => {
    if (!enforcePerformanceBudgets) return;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => reportPerformanceBudget("probe", 617.4, 250)).toThrow(
        "probe 617.40ms exceeded its 250ms budget",
      );
    } finally {
      stderr.mockRestore();
    }
  });
});
