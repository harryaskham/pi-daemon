/**
 * Predicate for the deterministic gate's wall-clock rule.
 *
 * Wall-clock budgets are measured everywhere and asserted only under
 * `PI_DAEMON_PERFORMANCE_BUDGETS=1`, because a millisecond bound missed on a
 * busy shared host says nothing about the code. That rule was applied to the
 * Node, web unit, and browser suites, but nothing stopped the next author from
 * writing a fresh `expect(elapsed).toBeLessThan(250)` and reintroducing the
 * flake class — the rule lived only in prose and in reviewers' memory.
 *
 * This is a source-text check, which the negative-control convention in
 * CONTRIBUTING deliberately ranks below observing an effect. It is used here
 * because the property genuinely is a property of the source: "nobody has
 * written a bare wall-clock assertion into the standard gate" cannot be
 * observed by running the suite, since a bare bound passes on an idle machine.
 * It is a tripwire, not a proof: an author determined to evade it can, and the
 * predicate is extracted and negatively tested so that it cannot quietly stop
 * rejecting.
 */

/**
 * A read of the measurement clock.
 *
 * `performance.now()` only: `Date.now()` is used throughout the suites for
 * deadlines, expiry timestamps, and hang bounds, none of which are budgets.
 */
export const WALL_CLOCK_READ = /\bperformance\.now\s*\(/;

/** Any wall-clock read, including the ones used for deadlines. */
export const ANY_CLOCK_READ = /\b(?:performance|Date)\.now\s*\(/;

/** The reporter that measures always and asserts only when enforcement is on. */
export const BUDGET_REPORTER = /\breportPerformanceBudget\b/;

/**
 * Expressions whose value is a duration or a percentile of durations.
 *
 * Name-based, so it is evadable by naming a duration `t`. That is acceptable:
 * the rule exists to stop the accidental reintroduction of a bound, not a
 * deliberate one, and a deliberate one is visible in review. Counts and lengths
 * of timing samples are excluded — `latency.count` is a cardinality, not a
 * duration.
 */
const TIMING_EXPRESSION =
  /(?:^|[^A-Za-z])(?:elapsed|duration|latency|took|percentile|p9\d)|[a-z]Ms\b|\bms\b/i;

const CARDINALITY_EXPRESSION = /\.(?:count|length|size)\s*$/;

const NUMERIC_LITERAL = String.raw`-?\d[\d_]*(?:\.\d+)?`;

const MATCHER_BOUND = new RegExp(
  String.raw`expect\(\s*(.+?)\s*\)\s*\.\s*(?:toBeLessThan|toBeGreaterThan|toBeLessThanOrEqual|toBeGreaterThanOrEqual)\s*\(\s*(${NUMERIC_LITERAL})\s*\)`,
);

const ASSERT_BOUND = new RegExp(
  String.raw`assert\.ok\(\s*(.+?)\s*(?:<|<=|>|>=)\s*(${NUMERIC_LITERAL})\s*[),]`,
);

/**
 * Report every way `source` breaks the deterministic gate's wall-clock rule.
 *
 * @param {string} path Repository-relative path, used for allow-list lookup.
 * @param {string} source File contents.
 * @param {{allowed?: Map<string, string>}} [options] Paths permitted to read a
 *   wall clock without reporting a budget, mapped to the reason.
 * @returns {Array<{path: string, kind: string, line: number, text: string}>}
 */
export function findWallClockViolations(path, source, options = {}) {
  const allowed = options.allowed ?? new Map();
  const violations = [];
  const lines = source.split("\n");

  if (WALL_CLOCK_READ.test(source) && !BUDGET_REPORTER.test(source) && !allowed.has(path)) {
    const index = lines.findIndex((line) => WALL_CLOCK_READ.test(line));
    violations.push({
      path,
      kind: "unreported-clock",
      line: index + 1,
      text: lines[index]?.trim() ?? "",
    });
  }

  lines.forEach((line, index) => {
    if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return;
    for (const pattern of [MATCHER_BOUND, ASSERT_BOUND]) {
      const match = pattern.exec(line);
      if (match === null) continue;
      const measured = match[1] ?? "";
      if (CARDINALITY_EXPRESSION.test(measured)) continue;
      if (!TIMING_EXPRESSION.test(measured) && !ANY_CLOCK_READ.test(measured)) continue;
      violations.push({ path, kind: "bare-bound", line: index + 1, text: line.trim() });
    }
  });

  return violations;
}

/** Render violations as an actionable failure message. */
export function describeWallClockViolations(violations) {
  return violations
    .map(({ path, kind, line, text }) => {
      const remedy =
        kind === "bare-bound"
          ? "report it through reportPerformanceBudget instead of asserting the bound"
          : "report the measurement through reportPerformanceBudget, or allow-list the file with a reason";
      return `${path}:${line} [${kind}] ${text}\n    ${remedy}`;
    })
    .join("\n");
}
