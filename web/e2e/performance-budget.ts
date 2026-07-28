import { expect, test } from "@playwright/test";

/**
 * Browser-suite counterpart of `test/performance-budget.mjs`.
 *
 * Wall-clock budgets are meaningful on an idle reference machine. The documented
 * Nix acceptance path (`docs/dash-e2e.md`) also runs on shared developer hosts
 * where a correct, unchanged implementation can miss a millisecond bound purely
 * because it was descheduled. That produces a red run that says nothing about
 * the code, which is exactly the failure mode the Node suite already refuses to
 * gate on.
 *
 * The measurements keep running and are recorded as annotations, so regressions
 * stay visible. Only the assertion is opt-in, through the same
 * `PI_DAEMON_PERFORMANCE_BUDGETS=1` switch the Node suite uses. Structural
 * invariants — virtualized row counts, layout, and behavior — remain
 * unconditional.
 */
export const PERFORMANCE_BUDGET_ENV = "PI_DAEMON_PERFORMANCE_BUDGETS";

export const enforcePerformanceBudgets = process.env[PERFORMANCE_BUDGET_ENV] === "1";

export function reportPerformanceBudget(label: string, measuredMs: number, budgetMs: number): void {
  const within = measuredMs < budgetMs;
  const description = `${label}: ${measuredMs.toFixed(2)}ms (budget ${budgetMs}ms)${
    within ? "" : " OVER"
  }${enforcePerformanceBudgets ? " [enforced]" : " [not enforced]"}`;
  test.info().annotations.push({ type: "performance-budget", description });
  if (enforcePerformanceBudgets) {
    expect(measuredMs, description).toBeLessThan(budgetMs);
  }
}
