// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { InfoPane } from "../components/InfoPane";
import type { SessionInfoResource } from "@harryaskham/pi-daemon/dashboard-contract";
import type { SessionFixture } from "../model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session: SessionFixture = {
  inventoryId: "inventory-tooling",
  sourceKind: "managed",
  title: "Managed worker",
  sessionId: "session-tooling",
  generation: 3,
  cwd: "/work/project",
  project: "project",
  model: "fixture/model",
  thinking: "medium",
  contextPercent: 12,
  createdAt: "2026-08-10T00:00:00.000Z",
  modifiedAt: "2026-08-10T00:01:00.000Z",
  activityAt: "2026-08-10T00:01:00.000Z",
  messageCount: 2,
  toolCallCount: 1,
  activation: { eligible: true, modes: ["reuse"] },
  presence: {
    runtime: "resident-idle",
    activation: "user-turn",
    focusedPaneCount: 1,
    unread: false,
  },
};

const info: SessionInfoResource = {
  ...session,
  cwd: session.cwd,
  source: { aliases: [] },
  ownership: { mode: "direct" },
  diagnostics: [],
  managed: {
    sessionId: session.sessionId,
    generation: session.generation,
    revision: 1,
    residency: "resident",
    state: "idle",
  },
  runtime: {
    readerCount: 1,
    warmLeaseCount: 0,
    isolation: "unisolated",
    toolMaterialization: {
      state: "materialized",
      truncated: false,
      active: ["bash", "caco_msg_send"],
      required: ["caco_msg_send"],
      entries: [
        {
          name: "bash",
          sourceClass: "builtin",
          policyDisposition: "allowed",
          availability: "resident",
          active: true,
          required: false,
        },
        {
          name: "caco_msg_send",
          sourceClass: "explicit-extension",
          policyDisposition: "required",
          availability: "resident",
          active: true,
          required: true,
        },
        {
          name: "write",
          sourceClass: "builtin",
          policyDisposition: "excluded",
          availability: "resident",
          active: false,
          required: false,
          omissionReason: "excluded_by_policy",
        },
      ],
      provenance: {
        source: "managed-profile",
        materializationGeneration: "profile-gen-42",
        authorization: {
          source: "controller",
          scope: "project:fixture",
          ownershipGeneration: "ownership-gen-7",
        },
      },
    },
    hostToolAdapterQueue: {
      capacity: { maxConcurrentRequests: 4, maxQueuedRequests: 16 },
      occupancy: { activeRequests: 2, queuedRequests: 3 },
      highWater: { activeRequests: 4, queuedRequests: 12 },
      acceptedRequests: 21,
      completedRequests: 15,
      failedRequests: 0,
      rejectedRequests: 1,
      cancelledRequests: 1,
      timedOutRequests: 0,
      lastRejectionReason: "adapter_queue_capacity",
      saturation: { active: false, count: 2, totalMs: 35, longestMs: 20 },
      operations: [
        {
          operation: "fs.read",
          activeRequests: 2,
          queuedRequests: 3,
          acceptedRequests: 21,
          completedRequests: 15,
          failedRequests: 0,
          rejectedRequests: 1,
          cancelledRequests: 1,
          timedOutRequests: 0,
          queueWaitMs: { count: 18, sum: 90, min: 0, max: 20, last: 4 },
          requestLatencyMs: { count: 16, sum: 160, min: 1, max: 30, last: 9 },
        },
      ],
    },
  },
};

describe("InfoPane tool materialization", () => {
  it("renders effective, required, omitted and provenance truth without resource paths", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<InfoPane session={session} info={info} />));
      const tooling = container.querySelector('[aria-labelledby="info-tooling"]');
      expect(tooling?.textContent).toContain("materialized");
      expect(tooling?.textContent).toContain("bash, caco_msg_send");
      expect(tooling?.textContent).toContain("write:excluded_by_policy");
      expect(tooling?.textContent).toContain("managed-profile · profile-gen-42");
      expect(tooling?.textContent).toContain("controller · project:fixture");
      expect(tooling?.textContent).toContain("ownership-gen-7");
      expect(tooling?.textContent).not.toContain("/work/project");
      const queue = container.querySelector('[aria-labelledby="info-tool-queue"]');
      expect(queue?.textContent).toContain("2 / 4 active · 3 / 16 queued");
      expect(queue?.textContent).toContain("4 active · 12 queued");
      expect(queue?.textContent).toContain("15 completed · 1 rejected · 1 cancelled");
      expect(queue?.textContent).toContain("adapter_queue_capacity");
      expect(queue?.textContent).toContain("fs.read");
      expect(queue?.textContent).toContain("5 ms avg · 20 ms max");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
