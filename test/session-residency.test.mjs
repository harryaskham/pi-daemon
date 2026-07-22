import assert from "node:assert/strict";
import test from "node:test";

import { MultiplexerError } from "../dist/multiplexer.js";
import { ensureSessionResident } from "../dist/session-residency.js";

function retainedFork(overrides = {}) {
  return {
    sessionId: "dash-imported",
    generation: 1,
    revision: 1,
    residency: "dormant",
    state: "idle",
    spec: {
      cwd: "/work/project",
      target: {
        mode: "fork",
        sourceSession: "inventory-source",
        sessionDir: "/state/owned/dash-imported",
      },
      model: {
        provider: "github-copilot",
        id: "gpt-5.6-sol",
        thinkingLevel: "high",
      },
      tools: { mode: "none" },
      resources: { extensions: [] },
      isolation: { mode: "unisolated" },
    },
    environment: { keys: [], persistence: "memory-only", provisioned: true },
    conversation: {
      sessionId: "pi-managed",
      sessionFile: "/state/owned/dash-imported/managed.jsonl",
    },
    ...overrides,
  };
}

test("retained imported sessions reopen the exact managed conversation without replaying fork source", async () => {
  const dormant = retainedFork();
  const resident = { ...dormant, residency: "resident" };
  const calls = [];
  let opened = false;
  const multiplexer = {
    async retainedSession() {
      return opened ? resident : dormant;
    },
    async open(command, options) {
      calls.push({ command: structuredClone(command), options: structuredClone(options) });
      opened = true;
    },
  };

  assert.equal(await ensureSessionResident(multiplexer, dormant.sessionId, 1), resident);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.runtimeOptions.persistedSpec.target, {
    mode: "open",
    path: dormant.conversation.sessionFile,
    sessionDir: "/state/owned/dash-imported",
  });
  assert.equal("resolvedSourceSessionPath" in calls[0].options.runtimeOptions, false);
  assert.deepEqual(calls[0].command.payload.session, {
    mode: "open",
    path: dormant.conversation.sessionFile,
  });
  assert.deepEqual(calls[0].options.catalogSpec, dormant.spec);
});

test("retained fork without managed identity fails closed instead of replaying its source", async () => {
  const dormant = retainedFork({ conversation: undefined });
  let opens = 0;
  const multiplexer = {
    async retainedSession() {
      return dormant;
    },
    async open() {
      opens += 1;
    },
  };
  await assert.rejects(
    ensureSessionResident(multiplexer, dormant.sessionId, 1),
    (error) =>
      error instanceof MultiplexerError && error.code === "conversation_identity_missing",
  );
  assert.equal(opens, 0);
});
