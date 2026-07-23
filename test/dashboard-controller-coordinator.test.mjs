import assert from "node:assert/strict";
import test from "node:test";

import { DashboardControllerCoordinator } from "../dist/dashboard-controller-coordinator.js";

const RESOURCE = { kind: "session", id: "managed:controller-session" };

function completed(correlationId) {
  return { correlationId, state: "completed" };
}

test("explicit handoff releases the old controller before granting the target", async () => {
  const coordinator = new DashboardControllerCoordinator();
  const order = [];
  let oldRole = "controller";
  let targetRole = "observer";
  coordinator.register({
    resource: RESOURCE,
    identityId: "owner",
    presentation: "rich",
    role: () => oldRole,
    async requestControl(correlationId) { oldRole = "controller"; return completed(correlationId); },
    async releaseControl(correlationId) { order.push("release-owner"); oldRole = "observer"; return completed(correlationId); },
    async close() {},
  });
  const target = coordinator.register({
    resource: RESOURCE,
    identityId: "operator",
    presentation: "tui",
    role: () => targetRole,
    async requestControl(correlationId) {
      assert.equal(oldRole, "observer");
      order.push("grant-operator");
      targetRole = "controller";
      return completed(correlationId);
    },
    async releaseControl(correlationId) { targetRole = "observer"; return completed(correlationId); },
    async close() {},
  });

  const result = await coordinator.transfer({
    resource: RESOURCE,
    targetIdentityId: "operator",
    targetParticipantId: target.participantId,
    expectedRevision: 0,
    correlationId: "handoff-1",
  });
  assert.deepEqual(order, ["release-owner", "grant-operator"]);
  assert.equal(result.previousControllerIdentityId, "owner");
  assert.equal(result.state.controllerIdentityId, "operator");
  assert.equal(result.state.revision, 2);
});

test("failed target grant never restores the released controller", async () => {
  const coordinator = new DashboardControllerCoordinator();
  let oldRole = "controller";
  let targetRequests = 0;
  coordinator.register({
    resource: RESOURCE,
    identityId: "owner",
    presentation: "rich",
    role: () => oldRole,
    async requestControl(correlationId) { oldRole = "controller"; return completed(correlationId); },
    async releaseControl(correlationId) { oldRole = "observer"; return completed(correlationId); },
    async close() {},
  });
  const target = coordinator.register({
    resource: RESOURCE,
    identityId: "operator",
    presentation: "rich",
    role: () => "observer",
    async requestControl(correlationId) {
      targetRequests += 1;
      return { correlationId, state: "rejected", error: { code: "busy", message: "busy", retryable: true } };
    },
    async releaseControl(correlationId) { return completed(correlationId); },
    async close() {},
  });

  await assert.rejects(
    coordinator.transfer({
      resource: RESOURCE,
      targetIdentityId: "operator",
      targetParticipantId: target.participantId,
      expectedRevision: 0,
      correlationId: "handoff-fail",
    }),
    (error) => error.code === "controller_transfer_failed",
  );
  assert.equal(oldRole, "observer");
  assert.equal(targetRequests, 1);
  assert.equal(coordinator.state(RESOURCE).controllerIdentityId, undefined);
});

test("revocation closes readers and downgrading to read releases controllers", async () => {
  const coordinator = new DashboardControllerCoordinator();
  let role = "controller";
  let closes = 0;
  coordinator.register({
    resource: RESOURCE,
    identityId: "operator",
    presentation: "rich",
    role: () => role,
    async requestControl(correlationId) { role = "controller"; return completed(correlationId); },
    async releaseControl(correlationId) { role = "observer"; return completed(correlationId); },
    async close() { closes += 1; },
  });
  await coordinator.applyIdentityRole(RESOURCE, "operator", "read");
  assert.equal(role, "observer");
  await coordinator.applyIdentityRole(RESOURCE, "operator", undefined);
  assert.equal(closes, 1);
});
