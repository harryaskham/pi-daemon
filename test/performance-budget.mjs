/**
 * Wall-clock performance budgets are deliberately NOT part of the deterministic
 * package/Nix/installation gate.
 *
 * Every budget here is a p95 or single-shot millisecond bound. Those bounds are
 * meaningful on an idle reference machine, but the standard suite also runs
 * inside Nix builders and on shared hosts that may be executing dozens of other
 * workloads. Under that contention a correct, unchanged implementation can miss
 * a millisecond bound purely because it was descheduled, which produces a red
 * gate that says nothing about the code. That failure mode has already blocked a
 * release pin once.
 *
 * The measurements themselves are cheap and stay in the standard suite, so the
 * exercised code paths keep their correctness coverage and the timings remain
 * visible as test diagnostics. Only the assertion is opt-in.
 *
 * Enforce the budgets explicitly with `npm run test:manual:performance`, which
 * sets `PI_DAEMON_PERFORMANCE_BUDGETS=1`, or by exporting that variable before
 * any targeted run. Run it on a quiet machine; a failure there is a real
 * regression signal.
 */

export const PERFORMANCE_BUDGET_ENV = "PI_DAEMON_PERFORMANCE_BUDGETS";

export const enforcePerformanceBudgets =
  process.env[PERFORMANCE_BUDGET_ENV] === "1";

/**
 * Record a measured wall-clock value against its budget.
 *
 * Always emits a diagnostic so regressions stay observable in ordinary runs, and
 * only asserts when budget enforcement is explicitly enabled.
 */
export function reportPerformanceBudget(context, label, measuredMs, budgetMs) {
  const within = measuredMs < budgetMs;
  context.diagnostic(
    `${label}: ${measuredMs.toFixed(2)}ms (budget ${budgetMs}ms)${
      within ? "" : " OVER"
    }${enforcePerformanceBudgets ? " [enforced]" : " [not enforced]"}`,
  );
  if (enforcePerformanceBudgets && !within) {
    throw new Error(
      `${label} ${measuredMs.toFixed(2)}ms exceeded its ${budgetMs}ms budget`,
    );
  }
}
