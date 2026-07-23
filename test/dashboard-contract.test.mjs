import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  DASH_API_PATHS,
  DASH_API_VERSION,
  DASH_DEFAULT_LIMITS,
  DASH_PERFORMANCE_BUDGETS,
  DASH_STREAM_SUBPROTOCOL,
  asDashboardCursor,
  asDashboardFingerprint,
} from "../dist/dashboard-contract.js";
import { createDashboardContractFixtures } from "../dist/dashboard-fixtures.js";

const readJson = async (path) =>
  JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
const fixture = (name) => readJson(`fixtures/dashboard-api/${name}`);

async function contractValidator() {
  const [schema, sessionSchema, extensionViewSchema, draftSchema] = await Promise.all([
    readJson("dashboard-api.schema.json"),
    readJson("session-api.schema.json"),
    readJson("extension-view.schema.json"),
    readJson("dashboard-session-draft.schema.json"),
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(sessionSchema);
  ajv.addSchema(extensionViewSchema);
  ajv.addSchema(draftSchema);
  ajv.addSchema(schema);
  const validate = (definition, value) => {
    const compiled = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
    assert.ok(compiled, `missing compiled schema definition: ${definition}`);
    assert.equal(
      compiled(value),
      true,
      `${definition}: ${ajv.errorsText(compiled.errors)}`,
    );
  };
  return { schema, ajv, validate };
}

test("typed builders and frozen Dash fixtures remain language-neutral equivalents", async () => {
  const typed = createDashboardContractFixtures();
  for (const [name, expected] of [
    ["capabilities.response.json", typed.capabilitiesEnvelope],
    ["inventory.response.json", typed.inventoryEnvelope],
    ["session-info.resource.json", typed.sessionInfo],
    ["transcript.response.json", typed.transcriptEnvelope],
    ["activation.request.json", typed.activationRequest],
    ["activation.ticket.json", typed.activationTicket],
    ["activation.states.json", typed.activationTickets],
    ["export.request.json", typed.exportRequest],
    ["export.ticket.json", typed.exportTicket],
    ["export.states.json", typed.exportTickets],
    ["presence.scenarios.json", typed.presenceScenarios],
    ["workspace.resource.json", typed.workspace],
    ["settings.resource.json", typed.settings],
    ["error.response.json", typed.errorEnvelope],
    ["stream.subscribe.json", typed.streamSubscribe],
    ["stream.extension-ui-response.json", typed.streamExtensionUiResponse],
    ["stream.ready.json", typed.streamReady],
    ["stream.event.json", typed.streamEvent],
    ["stream.extension-view.json", typed.streamExtensionView],
    ["stream.tui-delta.json", typed.streamTuiDelta],
    ["stream.replay-gap.json", typed.streamReplayGap],
    ["stream.replay-recovery.json", typed.replayRecovery],
    ["stream.multiplex.json", typed.multiplex],
  ]) {
    assert.deepEqual(await fixture(name), expected, name);
  }
});

test("published Dash fixtures validate against strict additive definitions", async () => {
  const { validate } = await contractValidator();
  for (const [name, definition] of [
    ["capabilities.response.json", "capabilitiesEnvelope"],
    ["inventory.response.json", "inventoryEnvelope"],
    ["session-info.resource.json", "sessionInfo"],
    ["transcript.response.json", "transcriptEnvelope"],
    ["activation.request.json", "activationRequest"],
    ["activation.ticket.json", "activationTicket"],
    ["activation.states.json", "activationTicketFixtureSet"],
    ["export.request.json", "exportRequest"],
    ["export.ticket.json", "exportTicket"],
    ["export.states.json", "exportTicketFixtureSet"],
    ["presence.scenarios.json", "presenceScenarioSet"],
    ["workspace.resource.json", "workspace"],
    ["settings.resource.json", "settings"],
    ["error.response.json", "errorEnvelope"],
    ["stream.subscribe.json", "streamSubscribeFrame"],
    ["stream.extension-ui-response.json", "streamExtensionUiResponseFrame"],
    ["stream.ready.json", "streamSubscriptionReadyFrame"],
    ["stream.event.json", "streamSessionEventFrame"],
    ["stream.extension-view.json", "streamSessionEventFrame"],
    ["stream.tui-delta.json", "streamTuiDeltaFrame"],
    ["stream.replay-gap.json", "streamReplayGapFrame"],
    ["stream.replay-recovery.json", "replayRecoveryFixture"],
    ["stream.multiplex.json", "multiplexFixture"],
  ]) {
    validate(definition, await fixture(name));
  }
});

test("preview, ownership, hydration, and normalized identity stay separate", async () => {
  const inventory = await fixture("inventory.response.json");
  const info = await fixture("session-info.resource.json");
  const transcript = await fixture("transcript.response.json");
  const inventoryJson = JSON.stringify(inventory);

  assert.equal(inventoryJson.includes("canonicalPath"), false);
  assert.equal(inventoryJson.includes("/srv/state/"), false);
  assert.equal(typeof info.source.canonicalPath, "string");
  assert.equal(transcript.data.hydration, "not-requested");
  assert.equal(transcript.data.records.every((record) => Object.keys(record.key).length > 0), true);
  assert.equal(
    transcript.data.records.find((record) => record.kind === "tool").key.toolCallId,
    "tool-call-01",
  );
});

test("activation/export states and liveness facts are independent and explicit", async () => {
  const activations = await fixture("activation.states.json");
  const exports = await fixture("export.states.json");
  const presence = await fixture("presence.scenarios.json");

  assert.deepEqual(
    Object.values(activations).map(({ mode, state }) => [mode, state]),
    [
      ["reuse", "succeeded"],
      ["direct", "queued"],
      ["fork", "running"],
    ],
  );
  assert.equal(exports.asNewSucceeded.state, "succeeded");
  assert.equal(exports.appendIndeterminate.mode, "append-to-origin");
  assert.equal(exports.appendIndeterminate.state, "indeterminate");

  const scheduledUnread = presence.find(
    (value) => value.activation === "scheduled-turn" && value.unread,
  );
  assert.ok(scheduledUnread);
  assert.equal(scheduledUnread.runtime, "dormant");
  assert.equal(typeof scheduledUnread.scheduled.nextWakeAt, "string");
  assert.ok(
    presence.some(
      (value) =>
        value.activation === "user-turn" && value.runtime === "dormant" && value.unread,
    ),
  );
  assert.ok(
    presence.some(
      (value) => value.runtime === "running" && value.activation === "running-at-dash-start",
    ),
  );
});

test("replay recovery and pane multiplexing retain host/generation/correlation truth", async () => {
  const recovery = await fixture("stream.replay-recovery.json");
  const multiplex = await fixture("stream.multiplex.json");

  assert.equal(recovery.gap.gap.snapshotFollows, true);
  assert.deepEqual(recovery.gap.gap.identity, recovery.freshSnapshot.identity);
  assert.equal(
    recovery.freshSnapshot.highWaterCursor,
    recovery.freshSnapshot.snapshot.highWaterCursor,
  );
  assert.notEqual(recovery.gap.gap.requestedCursor, recovery.freshSnapshot.highWaterCursor);

  const [first, second] = multiplex.subscriptions;
  assert.equal(first.clientId, second.clientId);
  assert.equal(first.workspaceId, second.workspaceId);
  assert.equal(first.sessionRef, second.sessionRef);
  assert.notEqual(first.subscriptionId, second.subscriptionId);
  assert.notEqual(first.correlationId, second.correlationId);
  assert.deepEqual(
    multiplex.ready.map(({ correlationId, subscriptionId }) => [correlationId, subscriptionId]),
    multiplex.subscriptions.map(({ correlationId, subscriptionId }) => [
      correlationId,
      subscriptionId,
    ]),
  );
});

test("capability negotiation publishes both peer renderers, all bounds, and budgets", async () => {
  const capabilities = (await fixture("capabilities.response.json")).data;
  assert.equal(capabilities.apiVersion, DASH_API_VERSION);
  assert.equal(capabilities.streamSubprotocol, DASH_STREAM_SUBPROTOCOL);
  assert.equal(capabilities.sameBrowserProtocolAcrossDeployments, true);
  assert.equal(capabilities.authentication.daemonBearerExposed, false);
  assert.equal(capabilities.presentations.rich.available, true);
  assert.equal(capabilities.presentations.tui.available, false);
  assert.equal(typeof capabilities.presentations.tui.unavailableReason, "string");
  assert.equal(capabilities.extensionViews.version, "1.0");
  assert.deepEqual(capabilities.extensionViews.renderers, { rich: "native", tui: "fallback", rpc: "transport" });
  assert.equal(capabilities.extensionViews.browserCodeExecution, false);
  assert.equal(capabilities.resources.treeNavigation, true);
  assert.equal(capabilities.presentations.rich.commands.includes("navigate_tree"), true);
  assert.deepEqual(capabilities.sessionDefaults, {
    spec: {
      cwd: "/home/fixture",
      persistence: "persistent",
      model: { provider: "github-copilot", id: "gpt-5.6-sol", thinkingLevel: "high" },
      tools: { mode: "default" },
      resources: { noExtensions: false, noSkills: false, noPromptTemplates: false, noThemes: false, noContextFiles: false, projectTrust: "approve" },
      isolation: { mode: "unisolated" },
    },
    sources: { cwd: "configured", model: "pi-settings", authority: "runtime-policy" },
  });
  assert.deepEqual(capabilities.limits, DASH_DEFAULT_LIMITS);
  assert.deepEqual(capabilities.performanceBudgets, DASH_PERFORMANCE_BUDGETS);
  assert.equal(
    Object.values(capabilities.limits).every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ),
    true,
  );
  assert.equal(DASH_PERFORMANCE_BUDGETS.persistedIndexBootstrapP95Ms, 50);
  assert.equal(DASH_PERFORMANCE_BUDGETS.firstSidebarRowsP95Ms, 150);
  assert.equal(DASH_PERFORMANCE_BUDGETS.cachedTranscriptViewportP95Ms, 150);
  assert.equal(DASH_PERFORMANCE_BUDGETS.coldTranscriptViewportP95Ms, 500);
  assert.equal(DASH_PERFORMANCE_BUDGETS.streamDeltaP95Ms, 50);
  assert.equal(DASH_PERFORMANCE_BUDGETS.tuiDeltaP95Ms, 50);
  assert.equal(DASH_PERFORMANCE_BUDGETS.frameWorkP95Ms, 16);
});

test("browser-storable fixtures contain no daemon bearer, cookie, credential, or authorization value", async () => {
  const fixtures = createDashboardContractFixtures();
  const serialized = JSON.stringify({
    capabilities: fixtures.capabilities,
    inventory: fixtures.inventory,
    transcript: fixtures.transcript,
    workspace: fixtures.workspace,
    settings: fixtures.settings,
    streamReady: fixtures.streamReady,
    streamExtensionView: fixtures.streamExtensionView,
  });
  for (const forbidden of [
    '"authorization"',
    '"cookie"',
    '"credential"',
    "service-bearer",
    "__Host-pi-daemon-dash",
  ]) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
});

test("schema rejects unkeyed/oversized ambiguity but permits additive minor fields", async () => {
  const { schema, ajv } = await contractValidator();
  const transcript = (await fixture("transcript.response.json")).data;
  const tool = structuredClone(transcript.records.find((record) => record.kind === "tool"));
  delete tool.key.toolCallId;
  delete tool.key.entryId;
  delete tool.key.messageId;
  const validateRecord = ajv.getSchema(
    `${schema.$id}#/$defs/normalizedTranscriptRecord`,
  );
  assert.ok(validateRecord);
  assert.equal(validateRecord(tool), false);

  const inventory = (await fixture("inventory.response.json")).data;
  inventory.sessions = Array.from({ length: 101 }, () => inventory.sessions[0]);
  const validatePage = ajv.getSchema(`${schema.$id}#/$defs/inventoryPage`);
  assert.ok(validatePage);
  assert.equal(validatePage(inventory), false);

  const message = structuredClone(transcript.records.find((record) => record.kind === "message"));
  message.state = "success";
  assert.equal(validateRecord(message), false);

  const validateClientFrame = ajv.getSchema(`${schema.$id}#/$defs/streamClientFrame`);
  assert.ok(validateClientFrame);
  assert.equal(
    validateClientFrame({
      dashVersion: "1.0",
      kind: "tui_input",
      clientId: "client-invalid-01",
      workspaceId: "workspace-invalid-01",
      correlationId: "correlation-invalid-01",
      subscriptionId: "subscription-invalid-01",
    }),
    false,
  );

  const capabilities = (await fixture("capabilities.response.json")).data;
  capabilities.futureMinorField = { ignoredByOlderClients: true };
  const validateCapabilities = ajv.getSchema(`${schema.$id}#/$defs/capabilities`);
  assert.ok(validateCapabilities);
  assert.equal(validateCapabilities(capabilities), true);

  assert.throws(() => asDashboardCursor(""), RangeError);
  assert.throws(() => asDashboardFingerprint("x".repeat(513)), RangeError);
});

test("OpenAPI publishes every route with browser-cookie auth and no daemon bearer scheme", async () => {
  const schema = await readJson("dashboard-api.schema.json");
  const draftSchema = await readJson("dashboard-session-draft.schema.json");
  const openapi = await readJson("dashboard-api.openapi.json");
  assert.equal(openapi.openapi, "3.1.0");
  assert.deepEqual(openapi.security, [{ dashSession: [] }]);
  assert.equal(openapi.components.securitySchemes.dashSession.in, "cookie");
  assert.equal(openapi.components.securitySchemes.dashSession.name, "__Host-pi-daemon-dash");
  assert.equal(Object.hasOwn(openapi.components.securitySchemes, "serviceBearer"), false);
  assert.deepEqual(openapi.paths["/login"].post.security, []);
  assert.equal(openapi.paths["/stream"].get["x-daemon-service-bearer-exposed"], false);

  for (const route of Object.values(DASH_API_PATHS)) {
    const relative = route.replace(/^\/dash\/v1/, "");
    assert.ok(openapi.paths[relative], `missing OpenAPI path: ${relative}`);
  }

  const resolvePointer = (pointer) =>
    pointer
      .slice(2)
      .split("/")
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce((value, part) => value?.[part], openapi);
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (typeof value.$ref === "string") {
      if (value.$ref.startsWith("./dashboard-api.schema.json#/$defs/")) {
        const definition = value.$ref.slice(value.$ref.lastIndexOf("/") + 1);
        assert.ok(schema.$defs[definition], `unresolved dashboard schema ref: ${value.$ref}`);
      } else if (value.$ref.startsWith("./dashboard-session-draft.schema.json#/$defs/")) {
        const definition = value.$ref.slice(value.$ref.lastIndexOf("/") + 1);
        assert.ok(draftSchema.$defs[definition], `unresolved draft schema ref: ${value.$ref}`);
      } else if (value.$ref.startsWith("#/")) {
        assert.notEqual(resolvePointer(value.$ref), undefined, `unresolved OpenAPI ref: ${value.$ref}`);
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(openapi);
});
