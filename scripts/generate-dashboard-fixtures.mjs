#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";

import { createDashboardContractFixtures } from "../dist/dashboard-fixtures.js";

const output = new URL("../fixtures/dashboard-api/", import.meta.url);
const sessionOutput = new URL("../fixtures/session-api/", import.meta.url);
await Promise.all([
  mkdir(output, { recursive: true }),
  mkdir(sessionOutput, { recursive: true }),
]);
const fixtures = createDashboardContractFixtures();
const files = {
  "capabilities.response.json": fixtures.capabilitiesEnvelope,
  "inventory.response.json": fixtures.inventoryEnvelope,
  "session-info.resource.json": fixtures.sessionInfo,
  "transcript.response.json": fixtures.transcriptEnvelope,
  "activation.request.json": fixtures.activationRequest,
  "activation.ticket.json": fixtures.activationTicket,
  "activation.states.json": fixtures.activationTickets,
  "export.request.json": fixtures.exportRequest,
  "export.ticket.json": fixtures.exportTicket,
  "export.states.json": fixtures.exportTickets,
  "presence.scenarios.json": fixtures.presenceScenarios,
  "workspace.resource.json": fixtures.workspace,
  "settings.resource.json": fixtures.settings,
  "error.response.json": fixtures.errorEnvelope,
  "stream.subscribe.json": fixtures.streamSubscribe,
  "stream.extension-ui-response.json": fixtures.streamExtensionUiResponse,
  "stream.ready.json": fixtures.streamReady,
  "stream.event.json": fixtures.streamEvent,
  "stream.tui-delta.json": fixtures.streamTuiDelta,
  "stream.replay-gap.json": fixtures.streamReplayGap,
  "stream.replay-recovery.json": fixtures.replayRecovery,
  "stream.multiplex.json": fixtures.multiplex,
};
for (const [name, value] of Object.entries(files)) {
  await writeFile(new URL(name, output), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
const serviceFiles = {
  "dashboard.capabilities.response.json": fixtures.serviceCapabilitiesEnvelope,
  "dashboard.inventory.response.json": fixtures.serviceInventoryEnvelope,
  "dashboard.info.response.json": fixtures.serviceInfoEnvelope,
  "dashboard.transcript.response.json": fixtures.serviceTranscriptEnvelope,
  "dashboard.activation.response.json": fixtures.serviceActivationEnvelope,
  "dashboard.export.response.json": fixtures.serviceExportEnvelope,
  "dashboard.lease.response.json": fixtures.serviceLeaseEnvelope,
  "dashboard.capabilities.invalid.json": {
    ...fixtures.serviceCapabilities,
    authentication: "browser-cookie",
  },
  "dashboard.lease.invalid.json": {
    requestId: "",
    leaseId: "",
  },
};
for (const [name, value] of Object.entries(serviceFiles)) {
  await writeFile(
    new URL(name, sessionOutput),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}
