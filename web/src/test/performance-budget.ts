import { reportTestDiagnostic } from "./test-diagnostic";

/**
 * Browser-suite mirror of `test/performance-budget.mjs`.
 *
 * Wall-clock budgets are deliberately NOT part of the deterministic gate. Every
 * budget here is a p95 or single-shot millisecond bound that is meaningful on an
 * idle reference machine, but `npm run web:test` also runs inside Nix builders
 * and on shared hosts executing dozens of other workloads. Under that contention
 * a correct, unchanged implementation can miss a millisecond bound purely
 * because it was descheduled, which produces a red gate that says nothing about
 * the code.
 *
 * The measurements stay in the standard run, so the exercised paths keep their
 * correctness coverage and the timings remain visible as diagnostics. Only the
 * assertion is opt-in: enforce with `npm run web:test:performance`, which sets
 * `PI_DAEMON_PERFORMANCE_BUDGETS=1`, or export that variable before a targeted
 * run. Run it on a quiet machine; a failure there is a real regression signal.
 */

export const PERFORMANCE_BUDGET_ENV = "PI_DAEMON_PERFORMANCE_BUDGETS";

/** True when this process was explicitly asked to enforce wall-clock budgets. */
export const enforcePerformanceBudgets =
  typeof process !== "undefined" && process.env?.[PERFORMANCE_BUDGET_ENV] === "1";

export interface PerformanceBudgetOutcome {
  readonly within: boolean;
  readonly enforced: boolean;
  readonly summary: string;
  /** Failure message when an enforced budget was missed, otherwise undefined. */
  readonly failure?: string;
}

/** Pure budget evaluation, shared by the reporter and its own unit tests. */
export function performanceBudgetOutcome(
  label: string,
  measuredMs: number,
  budgetMs: number,
  enforce: boolean = enforcePerformanceBudgets,
): PerformanceBudgetOutcome {
  const within = measuredMs < budgetMs;
  const measured = measuredMs.toFixed(2);
  const summary = `${label}: ${measured}ms (budget ${budgetMs}ms)${within ? "" : " OVER"}${
    enforce ? " [enforced]" : " [not enforced]"
  }`;
  if (within || !enforce) return { within, enforced: enforce, summary };
  return {
    within,
    enforced: enforce,
    summary,
    failure: `${label} ${measured}ms exceeded its ${budgetMs}ms budget`,
  };
}

/**
 * Record a measured wall-clock value against its budget.
 *
 * Always emits the measurement so regressions stay observable in ordinary runs,
 * and only throws when budget enforcement is explicitly enabled. The shared
 * test-diagnostic helper uses the project's supported stderr-first Vitest
 * channel, keeping this visible for passing tests without changing reporters.
 */
export function reportPerformanceBudget(
  label: string,
  measuredMs: number,
  budgetMs: number,
): void {
  const outcome = performanceBudgetOutcome(label, measuredMs, budgetMs);
  reportTestDiagnostic(`performance-budget ${outcome.summary}`);
  if (outcome.failure !== undefined) throw new Error(outcome.failure);
}
