import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  describeWallClockViolations,
  findWallClockViolations,
} from "./deterministic-gate.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Files permitted to read a wall clock without reporting a budget.
 *
 * Each entry needs a reason that says why the read is not a measurement anyone
 * asserts a bound against. Adding a file here to silence the check is the
 * failure this list exists to make visible.
 */
const ALLOWED_WALL_CLOCK_READS = new Map([
  [
    "web/src/test/dashboard-live-session.test.ts",
    "polling deadline: performance.now() bounds a wait loop and is compared against a timeout, not asserted as a budget",
  ],
]);

const SUITES = [
  { directory: "test", suffix: ".test.mjs" },
  { directory: "web/src/test", suffix: ".test.ts" },
  { directory: "web/e2e", suffix: ".spec.ts" },
];

// This file carries the negative cases as source strings, so scanning it would
// flag its own evidence.
const SELF = "test/deterministic-gate.test.mjs";

async function gateFiles() {
  const files = [];
  for (const { directory, suffix } of SUITES) {
    const entries = await readdir(join(repositoryRoot, directory));
    for (const entry of entries.filter((name) => name.endsWith(suffix)).sort()) {
      const path = `${directory}/${entry}`;
      if (path === SELF) continue;
      files.push({ path, source: await readFile(join(repositoryRoot, path), "utf8") });
    }
  }
  return files;
}

test("no suite in the deterministic gate asserts a bare wall-clock bound", async () => {
  const files = await gateFiles();
  assert.ok(files.length > 20, `expected the gate's suites, found ${files.length} files`);

  const violations = files.flatMap(({ path, source }) =>
    findWallClockViolations(path, source, { allowed: ALLOWED_WALL_CLOCK_READS }),
  );
  assert.deepEqual(
    violations,
    [],
    `wall-clock bounds must be reported, not asserted:\n${describeWallClockViolations(violations)}`,
  );
});

test("every allow-listed wall-clock read still exists and still reads a clock", async () => {
  // An allow-list entry that no longer matches reality is worse than none: it
  // silently exempts whatever later takes that path.
  for (const [path, reason] of ALLOWED_WALL_CLOCK_READS) {
    const source = await readFile(join(repositoryRoot, path), "utf8");
    assert.match(source, /\b(?:performance|Date)\.now\s*\(/, `${path} no longer reads a clock`);
    assert.ok(reason.length > 40, `${path} needs a reason, not a label`);
  }
});

test("the predicate rejects every shape the rule exists to prevent", () => {
  const cases = [
    {
      name: "matcher bound on an elapsed duration",
      source: "const elapsed = performance.now() - started;\nexpect(elapsed).toBeLessThan(250);\n",
      kind: "bare-bound",
    },
    {
      name: "assert bound on a millisecond-suffixed name",
      source: "const firstRowsMs = read();\nassert.ok(firstRowsMs < 150, 'too slow');\n",
      kind: "bare-bound",
    },
    {
      name: "bound on a clock delta with no name at all",
      source: "assert.ok(Date.now() - started < 500);\n",
      kind: "bare-bound",
    },
    {
      name: "percentile of samples compared with a literal",
      source: "reportPerformanceBudget('x', 1, 2);\nexpect(percentile(samples, 0.95)).toBeLessThan(16);\n",
      kind: "bare-bound",
    },
    {
      name: "bound applied directly to a clock read",
      source: "expect(performance.now() - started).toBeLessThan(16);\n",
      kind: "bare-bound",
    },
    {
      name: "clock read with no reporter and no allow-list entry",
      source: "const started = performance.now();\ndoWork();\n",
      kind: "unreported-clock",
    },
  ];

  for (const { name, source, kind } of cases) {
    const violations = findWallClockViolations("test/synthetic.test.mjs", source);
    assert.ok(violations.length > 0, `predicate accepted a violation: ${name}`);
    assert.ok(
      violations.some((violation) => violation.kind === kind),
      `${name} should report ${kind}, got ${violations.map((v) => v.kind).join(", ")}`,
    );
    assert.match(describeWallClockViolations(violations), /reportPerformanceBudget/);
  }
});

test("the predicate accepts the shapes the rule does not cover", () => {
  const accepted = [
    {
      name: "a bounded count, which is a structural invariant rather than a duration",
      source: "expect(renderedRows).toBeLessThan(40);\n",
    },
    {
      name: "a cardinality of timing samples",
      source: "assert.ok(latency.count >= 6);\n",
    },
    {
      name: "a hang bound compared against a named constant rather than a literal",
      source: "const started = Date.now();\nassert.ok(Date.now() - started < DISPOSE_HANG_BOUND_MS);\n",
    },
    {
      name: "a reported measurement",
      source:
        "const elapsed = performance.now() - started;\nreportPerformanceBudget('projection', elapsed, 250);\n",
    },
    {
      name: "a commented-out bound",
      source: "// expect(elapsed).toBeLessThan(250);\nreportPerformanceBudget('x', 1, 2);\n",
    },
  ];

  for (const { name, source } of accepted) {
    assert.deepEqual(
      findWallClockViolations("test/synthetic.test.mjs", source),
      [],
      `predicate rejected an acceptable shape: ${name}`,
    );
  }
});

test("an allow-listed path exempts only the clock read, never a bare bound", () => {
  const allowed = new Map([["test/synthetic.test.mjs", "a reason long enough to describe the exemption"]]);
  const source = "const deadline = performance.now() + timeoutMs;\nexpect(elapsed).toBeLessThan(250);\n";
  const violations = findWallClockViolations("test/synthetic.test.mjs", source, { allowed });
  assert.deepEqual(
    violations.map((violation) => violation.kind),
    ["bare-bound"],
    "allow-listing a file must not licence a bare bound inside it",
  );
});
