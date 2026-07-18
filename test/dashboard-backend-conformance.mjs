import assert from "node:assert/strict";

/** Shared deployment-neutral resource contract for embedded and remote backends. */
const immediate = () => new Promise((resolve) => setImmediate(resolve));

export async function assertDashboardBackendResourceConformance({
  backend,
  fixtures,
  sessionRef = fixtures.sessionInfo.managed.sessionId,
}) {
  const capabilities = await backend.capabilities();
  assert.equal(capabilities.apiVersion, "1.0");
  assert.equal(capabilities.authentication.daemonBearerExposed, false);
  assert.equal(capabilities.presentations.rich.available, true);
  assert.equal(capabilities.presentations.rich.replay, true);
  assert.equal(capabilities.presentations.rich.controller, true);

  assert.deepEqual(await backend.listSessions({ limit: 20 }), fixtures.inventory);
  assert.equal(
    (await backend.getSessionInfo(fixtures.sessionInfo.inventoryId)).inventoryId,
    fixtures.sessionInfo.inventoryId,
  );
  assert.deepEqual(
    await backend.getTranscript(fixtures.sessionInfo.inventoryId, { limit: 20 }),
    fixtures.transcript,
  );
  assert.deepEqual(
    await backend.activateSession(fixtures.sessionInfo.inventoryId, fixtures.activationRequest),
    fixtures.activationTicket,
  );
  assert.deepEqual(
    await backend.getActivation(fixtures.activationTicket.ticketId),
    fixtures.activationTicket,
  );
  assert.deepEqual(
    await backend.exportSession(sessionRef, fixtures.exportRequest),
    fixtures.exportTicket,
  );
  assert.deepEqual(
    await backend.getExport(fixtures.exportTicket.ticketId),
    fixtures.exportTicket,
  );
  assert.equal((await backend.getManagedSession(sessionRef)).generation, 3);
}

/** Shared Rich-channel controller/replay contract for both deployment modes. */
export async function assertDashboardRichChannelConformance({
  backend,
  sessionRef,
  emitSessionEvent,
  expectedEntries,
}) {
  const observer = await backend.openSessionChannel({
    sessionRef,
    role: "observer",
  });
  const initialCursor = observer.snapshot.highWaterCursor;
  const controller = await backend.openSessionChannel({
    sessionRef,
    role: "controller",
  });
  assert.equal(observer.role, "observer");
  assert.equal(controller.role, "controller");
  assert.equal(controller.snapshot.entries.length, expectedEntries);

  const observerEvents = [];
  const controllerEvents = [];
  observer.subscribe((event) => observerEvents.push(event));
  controller.subscribe((event) => controllerEvents.push(event));
  await emitSessionEvent({ type: "message_update", conformance: true });
  await immediate();
  assert.equal(observerEvents.at(-1).kind, "session_event");
  assert.deepEqual(observerEvents.at(-1), controllerEvents.at(-1));

  const replay = await backend.openSessionChannel({
    sessionRef,
    role: "observer",
    cursor: initialCursor,
  });
  const replayEvents = [];
  replay.subscribe((event) => replayEvents.push(event));
  assert.equal(replayEvents.filter((event) => event.kind === "session_event").length, 1);

  const denied = await observer.command({
    correlationId: "shared-collision",
    identity: observer.identity,
    operation: "prompt",
    payload: { message: "observer must not mutate" },
  });
  assert.equal(denied.state, "rejected");
  assert.equal(denied.error.code, "controller_required");
  const [observerRead, controllerRead] = await Promise.all([
    observer.command({
      correlationId: "shared-collision",
      identity: observer.identity,
      operation: "get_state",
    }),
    controller.command({
      correlationId: "shared-collision",
      identity: controller.identity,
      operation: "get_state",
    }),
  ]);
  assert.equal(observerRead.state, "completed");
  assert.equal(controllerRead.state, "completed");
  assert.equal(observerRead.correlationId, "shared-collision");
  assert.equal(controllerRead.correlationId, "shared-collision");

  assert.equal((await controller.releaseControl("shared-release")).state, "completed");
  assert.equal((await observer.requestControl("shared-grant")).state, "completed");
  assert.equal(observer.role, "controller");

  await replay.close();
  await controller.close();
  await observer.close();
}
