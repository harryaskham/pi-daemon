// Consumer acceptance for the neutral client path (bd-d54659).
//
// PLAN.md section "End-to-end consumer" calls for launching the packaged daemon
// as a service, creating several logical agents, and proving no new process
// appears per agent. The wake half needs credentials and stays opt-in; this is
// the credential-free remainder, and it runs against whichever executable
// PI_DAEMON_PACKAGED_BIN names, so the Nix lane can point it at the artifact.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PiDaemonClient } from "../dist/client.js";
import {
  ACCEPTANCE_PROVIDER,
  countDescendants,
  PACKAGED_BIN_ENV,
  resolveDaemonCommand,
  startDaemon,
  stopDaemon,
} from "./consumer-acceptance.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function openRequest(sessionId, generation, cwd) {
  // The shape docs/integration.md publishes to consumers, kept literal so a
  // drift between the documented example and the accepted request shows up here.
  return {
    protocolVersion: "1.0",
    requestId: `open-${sessionId}`,
    operation: "open",
    sessionId,
    generation,
    payload: {
      cwd,
      session: { mode: "new" },
      model: { provider: ACCEPTANCE_PROVIDER, id: "gpt-5-mini" },
      resources: {
        extensions: "none",
        skills: "none",
        promptTemplates: "none",
        themes: "none",
        contextFiles: "none",
        tools: "none",
      },
    },
  };
}

test("the launch target is chosen by environment, defaulting to the source tree", () => {
  const fromSource = resolveDaemonCommand({}, repositoryRoot);
  assert.equal(fromSource.packaged, false);
  assert.deepEqual(fromSource.leadingArgs, ["dist/cli.js"]);

  const packaged = resolveDaemonCommand({ [PACKAGED_BIN_ENV]: "/nix/store/x/bin/pi-daemon" }, repositoryRoot);
  assert.equal(packaged.packaged, true);
  assert.equal(packaged.command, "/nix/store/x/bin/pi-daemon");
  assert.deepEqual(packaged.leadingArgs, [], "a packaged wrapper takes its own argv, not a script path");

  // Whitespace-only is an unset variable that survived a shell expansion, not a
  // path; treating it as one would launch the empty string.
  assert.equal(resolveDaemonCommand({ [PACKAGED_BIN_ENV]: "   " }, repositoryRoot).packaged, false);
});

test("a consumer opens many logical sessions without a process per session", async (t) => {
  const daemon = await startDaemon(t, { repositoryRoot });
  const client = await PiDaemonClient.connect({ socketPath: daemon.socketPath });
  t.after(() => client.close());
  await client.handshake("consumer-acceptance-handshake");

  const baseline = await countDescendants(daemon.child.pid);

  const sessions = ["agent-alpha", "agent-beta", "agent-gamma", "agent-delta"];
  for (const sessionId of sessions) {
    const response = await client.request(openRequest(sessionId, 1, daemon.work));
    assert.equal(response.ok, true, `open ${sessionId}: ${JSON.stringify(response.error ?? {})}`);
  }

  const afterOpens = await countDescendants(daemon.child.pid);
  if (baseline !== null && afterOpens !== null) {
    // The claim the whole design rests on: logical sessions are multiplexed into
    // the one process, so opening several must not spawn several.
    assert.equal(
      afterOpens,
      baseline,
      `opening ${sessions.length} sessions changed the daemon's process tree from ${baseline} to ${afterOpens}`,
    );
  }

  // Status is the neutral read a consumer polls; assert it answers for a live
  // session rather than only that the socket is up.
  const status = await client.request({
    protocolVersion: "1.0",
    requestId: "status-1",
    operation: "status",
    sessionId: sessions[0],
    generation: 1,
    payload: {},
  });
  assert.equal(status.ok, true, `status: ${JSON.stringify(status.error ?? {})}`);

  for (const sessionId of sessions) {
    const closed = await client.request({
      protocolVersion: "1.0",
      requestId: `close-${sessionId}`,
      operation: "close",
      sessionId,
      generation: 1,
      payload: {},
    });
    assert.equal(closed.ok, true, `close ${sessionId}: ${JSON.stringify(closed.error ?? {})}`);
  }

  const afterCloses = await countDescendants(daemon.child.pid);
  if (baseline !== null && afterCloses !== null) {
    assert.equal(afterCloses, baseline, "closing sessions must not leave processes behind");
  }

  client.close();
  await stopDaemon(daemon.child);
});

test("the descendant walk finds descendants at all", { timeout: 30_000 }, async (t) => {
  // Without this the acceptance above is vacuous in its most likely failure
  // direction: if the /proc parsing broke, countDescendants would return 0 for
  // every input and "no process per session" would hold no matter what the
  // daemon did. Ported from the acceptance this consolidated (bd-c4c80b), whose
  // own first attempt at this control was wrong — it spawned a child from the
  // test process and expected the *daemon's* count to move, which proved only
  // that the child was not a daemon descendant.
  const baseline = await countDescendants(process.pid);
  if (baseline === null) return; // Not Linux; the acceptance skips its count too.

  const parent = spawn(
    process.execPath,
    [
      "-e",
      "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' }); setTimeout(() => {}, 5000);",
    ],
    { stdio: "ignore" },
  );
  t.after(() => {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
  });
  await new Promise((resolve) => setTimeout(resolve, 500));

  const observed = await countDescendants(process.pid);
  assert.ok(
    observed >= baseline + 2,
    `expected the child and its grandchild, went from ${baseline} to ${observed}: the walk must be ` +
      "transitive, or a process spawned by something the daemon spawned would escape the acceptance",
  );
});
