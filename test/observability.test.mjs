import assert from "node:assert/strict";
import test from "node:test";

import {
  HostMetrics,
  JsonLineLogger,
  sanitizeLogFields,
} from "../dist/observability.js";

test("metrics expose deterministic counters and bounded numeric summaries", () => {
  const metrics = new HostMetrics();
  metrics.increment("z", 2);
  metrics.increment("a");
  metrics.observe("latency", 10);
  metrics.observe("latency", 20);
  assert.deepEqual(metrics.snapshot(), {
    counters: { a: 1, z: 2 },
    summaries: {
      latency: { count: 2, sum: 30, min: 10, max: 20, last: 20 },
    },
  });
});

test("structured logger redacts content credentials and nested sensitive fields", () => {
  const lines = [];
  const logger = new JsonLineLogger((line) => lines.push(line), { component: "test" });
  logger.write("info", "turn_completed", {
    sessionId: "agent-a",
    prompt: "private prompt",
    apiKey: "secret-key",
    nested: { output: "private output", safe: "visible" },
  });
  const record = JSON.parse(lines[0]);
  assert.equal(record.sessionId, "agent-a");
  assert.equal(record.prompt, "[redacted]");
  assert.equal(record.apiKey, "[redacted]");
  assert.equal(record.nested.output, "[redacted]");
  assert.equal(record.nested.safe, "visible");
  assert.equal(JSON.stringify(record).includes("private"), false);

  const deep = { safe: "ok", token: "hidden" };
  deep.self = deep;
  assert.doesNotThrow(() => sanitizeLogFields(deep));
});
