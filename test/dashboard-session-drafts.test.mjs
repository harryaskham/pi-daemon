import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DashboardSessionDraftError,
  DashboardSessionDraftService,
  FileDashboardSessionDraftStore,
  dashboardSessionDraftSpecToSessionSpec,
} from "../dist/dashboard-session-drafts.js";

const spec = (cwd, overrides = {}) => ({
  cwd,
  persistence: "persistent",
  tools: { mode: "none" },
  resources: {
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    projectTrust: "deny",
  },
  isolation: { mode: "unisolated" },
  ...overrides,
});

async function harness(t, ids = ["one", "two", "three", "four"]) {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-drafts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const work = join(root, "work");
  await Promise.all([mkdir(stateDir, { mode: 0o700 }), mkdir(work, { mode: 0o700 })]);
  const queue = [...ids];
  let extra = 0;
  const store = new FileDashboardSessionDraftStore({
    stateDir,
    randomId: () => queue.shift() ?? `extra-${extra++}`,
  });
  const service = new DashboardSessionDraftService({ store, allowedRoots: [work] });
  await service.recover();
  return { root, stateDir, work, store, service };
}

function createRequest(work, overrides = {}) {
  return {
    requestId: "create-1",
    idempotencyKey: "create-key-1",
    spec: spec(work),
    ...overrides,
  };
}

test("draft CRUD is durable, idempotent, root-confined, and performs no runtime work", async (t) => {
  const h = await harness(t);
  const created = await h.service.create(createRequest(h.work));
  assert.equal(created.state, "draft");
  assert.equal(created.firstMessageStartsSession, true);
  assert.equal(created.draftId, "draft-one");
  assert.equal(created.spec.cwd, await realpath(h.work));
  assert.deepEqual(await h.service.create(createRequest(h.work)), created);

  await assert.rejects(
    h.service.create(createRequest(h.work, { spec: spec(h.work, { persistence: "memory" }) })),
    (error) => error instanceof DashboardSessionDraftError && error.code === "draft_idempotency_conflict",
  );
  await assert.rejects(
    h.service.create(createRequest(h.stateDir, { idempotencyKey: "outside-root" })),
    (error) => error instanceof DashboardSessionDraftError && error.code === "draft_cwd_not_allowed",
  );

  const restarted = new FileDashboardSessionDraftStore({ stateDir: h.stateDir });
  const recovery = await restarted.recover();
  assert.equal(recovery.drafts, 1);
  assert.equal((await restarted.get(created.draftId)).state, "draft");

  const cancelled = await restarted.cancel(created.draftId, {
    requestId: "cancel-1",
    idempotencyKey: "cancel-key-1",
    expectedRevision: 1,
  });
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.revision, 2);
  assert.equal(
    (await restarted.cancel(created.draftId, {
      requestId: "cancel-2",
      idempotencyKey: "cancel-key-1",
      expectedRevision: 1,
    })).revision,
    2,
  );
});

test("allowed-root symlink aliases canonicalize once before cwd containment", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-draft-root-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const work = join(root, "work");
  const allowedAlias = join(root, "allowed-alias");
  await Promise.all([mkdir(stateDir, { mode: 0o700 }), mkdir(work, { mode: 0o700 })]);
  await symlink(work, allowedAlias, "dir");
  const service = new DashboardSessionDraftService({
    store: new FileDashboardSessionDraftStore({ stateDir }),
    allowedRoots: [allowedAlias],
  });
  await service.recover();
  const created = await service.create(createRequest(work, {
    draftId: "draft-root-alias",
    idempotencyKey: "draft-root-alias-key",
  }));
  assert.equal(created.spec.cwd, await realpath(work));
});

test("filesystem root authority admits a canonical home-like cwd without double-separator denial", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-draft-filesystem-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const work = join(root, "home", "operator");
  await Promise.all([mkdir(stateDir, { recursive: true, mode: 0o700 }), mkdir(work, { recursive: true, mode: 0o700 })]);
  const service = new DashboardSessionDraftService({
    store: new FileDashboardSessionDraftStore({ stateDir }),
    allowedRoots: ["/"],
  });
  await service.recover();
  const created = await service.create(createRequest(work, {
    draftId: "draft-filesystem-root",
    idempotencyKey: "draft-filesystem-root-key",
  }));
  assert.equal(created.spec.cwd, await realpath(work));
});

test("first-send admission retains immutable draft revision and transitions draft atomically", async (t) => {
  const h = await harness(t);
  const draft = await h.service.create(createRequest(h.work));
  const request = {
    requestId: "send-1",
    idempotencyKey: "send-key-1",
    expectedRevision: draft.revision,
    message: "Start exactly once",
  };
  const queued = await h.store.submitSend(draft.draftId, request);
  assert.equal(queued.state, "queued");
  assert.equal(queued.draftRevision, 1);
  assert.deepEqual(await h.store.submitSend(draft.draftId, request), queued);
  assert.equal((await h.store.get(draft.draftId)).revision, 2);
  assert.equal((await h.store.get(draft.draftId)).state, "materializing");
  const work = await h.store.getSendWork(queued.ticketId);
  assert.equal(work.message, "Start exactly once");
  assert.equal(work.phase, "materializing");
  assert.match(work.targetSession.sessionId, /^dash-[a-f0-9]{40}$/);
  assert.equal(work.targetSession.generation, 1);
  assert.equal("message" in (await h.store.getSend(queued.ticketId)), false);

  await h.store.transitionSend(queued.ticketId, {
    expectedState: "queued",
    state: "running",
    phase: "materializing",
  });
  await assert.rejects(
    h.store.transitionSend(queued.ticketId, {
      expectedState: "running",
      state: "running",
      phase: "ready-to-prompt",
      session: { sessionId: "wrong-session", generation: 1 },
    }),
    (error) => error instanceof DashboardSessionDraftError && error.code === "draft_session_identity_conflict",
  );
  const ready = await h.store.transitionSend(queued.ticketId, {
    expectedState: "running",
    state: "running",
    phase: "ready-to-prompt",
    session: work.targetSession,
  });
  assert.deepEqual(ready.session, work.targetSession);
  await h.store.transitionSend(queued.ticketId, {
    expectedState: "running",
    state: "running",
    phase: "prompt-submitting",
    session: work.targetSession,
  });
  const succeeded = await h.store.transitionSend(queued.ticketId, {
    expectedState: "running",
    state: "succeeded",
    session: work.targetSession,
  });
  assert.equal(succeeded.state, "succeeded");
  assert.equal(succeeded.draftRevision, 1);
  const live = await h.store.get(draft.draftId);
  assert.equal(live.state, "live");
  assert.deepEqual(live.materialization.session, work.targetSession);

  assert.deepEqual(dashboardSessionDraftSpecToSessionSpec(draft.spec), {
    cwd: draft.spec.cwd,
    target: { mode: "new" },
    tools: { mode: "none" },
    resources: draft.spec.resources,
    isolation: { mode: "unisolated" },
  });
});

test("cancel terminal-fails queued send and restart makes running work indeterminate", async (t) => {
  const h = await harness(t);
  const first = await h.service.create(createRequest(h.work));
  const firstTicket = await h.store.submitSend(first.draftId, {
    requestId: "send-cancel",
    idempotencyKey: "send-cancel-key",
    expectedRevision: 1,
    message: "cancel me",
  });
  const cancelled = await h.store.cancel(first.draftId, {
    requestId: "cancel-send",
    idempotencyKey: "cancel-send-key",
    expectedRevision: 2,
  });
  assert.equal(cancelled.state, "cancelled");
  const failed = await h.store.getSend(firstTicket.ticketId);
  assert.equal(failed.state, "failed");
  assert.equal(failed.error.code, "draft_cancelled");

  const second = await h.service.create(createRequest(h.work, {
    requestId: "create-2",
    idempotencyKey: "create-key-2",
  }));
  const secondTicket = await h.store.submitSend(second.draftId, {
    requestId: "send-running",
    idempotencyKey: "send-running-key",
    expectedRevision: 1,
    message: "uncertain",
  });
  const secondWork = await h.store.getSendWork(secondTicket.ticketId);
  await h.store.transitionSend(secondTicket.ticketId, {
    expectedState: "queued",
    state: "running",
    phase: "materializing",
  });
  await h.store.transitionSend(secondTicket.ticketId, {
    expectedState: "running",
    state: "running",
    phase: "ready-to-prompt",
    session: secondWork.targetSession,
  });
  await h.store.transitionSend(secondTicket.ticketId, {
    expectedState: "running",
    state: "running",
    phase: "prompt-submitting",
    session: secondWork.targetSession,
  });

  const third = await h.service.create(createRequest(h.work, {
    requestId: "create-3",
    idempotencyKey: "create-key-3",
  }));
  const recoverable = await h.store.submitSend(third.draftId, {
    requestId: "send-queued",
    idempotencyKey: "send-queued-key",
    expectedRevision: 1,
    message: "safe to resume",
  });

  const restarted = new FileDashboardSessionDraftStore({ stateDir: h.stateDir });
  const recovery = await restarted.recover();
  assert.equal(recovery.indeterminateTickets, 1);
  assert.deepEqual(recovery.recoverableTicketIds, [recoverable.ticketId]);
  const uncertain = await restarted.getSend(secondTicket.ticketId);
  assert.equal(uncertain.state, "indeterminate");
  assert.equal(uncertain.error.code, "draft_send_indeterminate");
  assert.equal((await restarted.get(second.draftId)).state, "indeterminate");
});

test("cancellation after prompt submission is indeterminate and never replayable", async (t) => {
  const h = await harness(t);
  const draft = await h.service.create(createRequest(h.work));
  const queued = await h.store.submitSend(draft.draftId, {
    requestId: "send-race",
    idempotencyKey: "send-race-key",
    expectedRevision: 1,
    message: "may already be accepted",
  });
  const work = await h.store.getSendWork(queued.ticketId);
  await h.store.transitionSend(queued.ticketId, {
    expectedState: "queued",
    state: "running",
    phase: "materializing",
  });
  await h.store.transitionSend(queued.ticketId, {
    expectedState: "running",
    state: "running",
    phase: "ready-to-prompt",
    session: work.targetSession,
  });
  await h.store.transitionSend(queued.ticketId, {
    expectedState: "running",
    state: "running",
    phase: "prompt-submitting",
    session: work.targetSession,
  });
  const current = await h.store.get(draft.draftId);
  const uncertain = await h.store.cancel(draft.draftId, {
    requestId: "cancel-race",
    idempotencyKey: "cancel-race-key",
    expectedRevision: current.revision,
  });
  assert.equal(uncertain.state, "indeterminate");
  assert.equal(uncertain.materialization.error.code, "draft_cancel_indeterminate");
  assert.equal((await h.store.getSend(queued.ticketId)).state, "indeterminate");
  const restarted = new FileDashboardSessionDraftStore({ stateDir: h.stateDir });
  assert.deepEqual((await restarted.recover()).recoverableTicketIds, []);
});

test("failed atomic writes roll back in-memory draft and ticket mutations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-draft-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const work = join(root, "work");
  await Promise.all([mkdir(stateDir, { mode: 0o700 }), mkdir(work, { mode: 0o700 })]);
  const store = new FileDashboardSessionDraftStore({
    stateDir,
    limits: { maxStateBytes: 256 },
    randomId: () => "rollback",
  });
  const service = new DashboardSessionDraftService({ store, allowedRoots: [work] });
  await service.recover();
  await assert.rejects(
    service.create({
      requestId: "rollback-create",
      idempotencyKey: "rollback-create-key",
      draftId: "draft-rollback",
      spec: spec(work, { name: "x".repeat(128) }),
    }),
    (error) => error instanceof DashboardSessionDraftError && error.code === "draft_state_too_large",
  );
  assert.equal(await store.get("draft-rollback"), undefined);
});

test("invalid or insecure draft state is quarantined or refused", async (t) => {
  const h = await harness(t);
  await h.service.create(createRequest(h.work));
  const path = join(h.stateDir, "web", "session-drafts-v1.json");
  await writeFile(path, "not-json\n", { mode: 0o600 });
  const corrupt = new FileDashboardSessionDraftStore({ stateDir: h.stateDir });
  const recovered = await corrupt.recover();
  assert.equal(recovered.drafts, 0);
  assert.match(recovered.quarantined, /\.corrupt-/);

  await writeFile(path, "{}\n");
  await chmod(path, 0o644);
  const permissive = new FileDashboardSessionDraftStore({ stateDir: h.stateDir });
  await assert.rejects(permissive.recover(), /owner-only|permissions|private/i);
  await chmod(path, 0o600);
});
