import type { SessionFixture, TranscriptRecord } from "./model";

const PROJECTS = ["aurora", "atlas", "cosmos", "harbor", "relay", "studio"] as const;
const MODELS = ["gpt-5.6", "claude-opus-4.8", "gemini-3.1-pro", "gpt-5-mini"] as const;
const TITLES = [
  "Refine streaming tool cards",
  "Audit protocol generation fences",
  "Build the midnight session workspace",
  "Trace bounded reconnect behavior",
  "Polish split pane navigation",
  "Review runtime recovery receipts",
  "Design semantic transcript states",
  "Verify owner-private session export",
] as const;

function at<T>(items: readonly T[], index: number): T {
  const item = items[index % items.length];
  if (item === undefined) throw new Error("fixture source cannot be empty");
  return item;
}

function inventoryId(index: number): string {
  return `inv_${index.toString(36).padStart(6, "0")}`;
}

function entryId(index: number): string {
  return `entry_${index.toString(36).padStart(7, "0")}`;
}

export function createSessionFixtures(count = 10_000): SessionFixture[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => {
    const project = at(PROJECTS, index);
    const runtime = index === 4 ? "failed" : index % 29 === 0 ? "running" : index % 5 === 0 ? "resident-idle" : "dormant";
    const scheduled = index % 17 === 0;
    const sessionId = `session-${index.toString().padStart(5, "0")}`;
    const generation = 1 + (index % 4);
    const modifiedAt = new Date(now - index * 73_000).toISOString();
    return {
      inventoryId: inventoryId(index),
      sourceKind: index % 11 === 0 ? "external" : index % 13 === 0 ? "imported" : index % 19 === 0 ? "memory" : "managed",
      title: `${at(TITLES, index)} · ${index.toString().padStart(5, "0")}`,
      cwdBasename: index % 23 === 0 ? "dashboard" : "src",
      projectLabel: project,
      piSessionId: `pi-${sessionId}`,
      createdAt: new Date(now - (index + 90) * 91_000).toISOString(),
      modifiedAt,
      messageCount: 12 + (index % 640),
      entryCount: 20 + (index % 1_100),
      toolCallCount: 3 + (index % 180),
      currentLeafId: `entry-leaf-${index}`,
      managed: {
        sessionId,
        generation,
        revision: 1 + (index % 8),
        residency: runtime === "dormant" ? "dormant" : "resident",
        state: runtime === "running" ? "running" : runtime === "failed" ? "failed" : "idle",
      },
      activation: { eligible: true, modes: ["reuse", "fork"] },
      presence: {
        runtime,
        activation: runtime === "running" ? "user-turn" : index % 7 === 0 ? "selected" : "untouched",
        focusedPaneCount: runtime === "running" ? 1 : 0,
        unread: index % 9 === 0,
        ...(scheduled ? { scheduled: { nextWakeAt: new Date(now + (index % 14 + 1) * 60_000).toISOString(), source: "fixture-schedule" } } : {}),
      },
      sessionId,
      generation,
      cwd: `/work/${project}/${index % 23 === 0 ? "packages/dashboard" : "src"}`,
      project,
      model: at(MODELS, index),
      thinking: at(["off", "minimal", "low", "medium", "high"] as const, index),
      contextPercent: 18 + (index % 69),
    } satisfies SessionFixture;
  });
}

const USER_PROMPTS = [
  "Make the interaction feel deliberate, calm, and visibly fast without hiding system truth.",
  "Can you inspect the protocol boundary and keep the browser independent from deployment mode?",
  "Please verify the keyboard path as carefully as the mouse path, including reduced motion.",
] as const;
const ASSISTANT_MESSAGES = [
  "I separated persisted preview from runtime hydration, then keyed every live merge by the Pi entry identity. The browser can now paint useful history immediately while the controller channel negotiates in parallel.",
  "The split tree keeps layout state independent from pane content. Directional navigation uses measured pane geometry, and a swap moves content while retaining focus on the moved pane.",
  "The theme is semantic rather than component-owned. Empty, error, loading, tool, streaming, focus, and attention states all resolve through the same validated Nord Midnight token vocabulary.",
] as const;

export function createTranscriptFixtures(count = 1_200): TranscriptRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const id = entryId(index);
    const timestamp = new Date(Date.now() - (count - index) * 28_000).toISOString();
    if (index % 11 === 4) {
      const state = index === count - 2 ? "pending" : index % 37 === 0 ? "error" : "success";
      const title = at(["Read dashboard contract", "Inspect fixture projection", "Apply semantic token patch", "Run focused layout checks"] as const, index);
      return {
        recordId: `tool:${id}`,
        key: { entryId: id, messageId: `message-${id}`, toolCallId: `tool-${id}` },
        kind: "tool",
        toolName: at(["read", "bash", "edit", "write", "search"] as const, index),
        state,
        source: "persisted",
        timestamp,
        arguments: { title },
        content: [{ type: state === "error" ? "error" : "text", text: state === "error" ? "The bounded fixture reported a recoverable stale cursor." : "Completed against the local fixture backend with redacted output." }],
        details: { durationMs: 18 + (index % 880) },
      };
    }
    if (index % 17 === 8) {
      return {
        recordId: `entry:${id}`,
        key: { entryId: id, messageId: `message-${id}` },
        kind: "message",
        role: "assistant",
        state: "complete",
        source: "persisted",
        timestamp,
        content: [{ type: "thinking", text: "Checking generation identity, viewport bounds, and the active branch before applying the next reducer delta." }],
      };
    }
    if (index % 29 === 12) {
      const compaction = index % 58 === 12;
      return {
        recordId: `timeline:${id}`,
        key: { entryId: id },
        kind: "timeline",
        event: compaction ? "compaction" : "model",
        label: compaction ? "Compaction complete" : "Model changed",
        data: { detail: compaction ? "Context summarized at a durable entry boundary." : "gpt-5.6 · high reasoning" },
        source: "persisted",
        timestamp,
      };
    }
    const role = index % 3 === 0 ? "user" : "assistant";
    return {
      recordId: `entry:${id}`,
      key: { entryId: id, messageId: `message-${id}` },
      kind: "message",
      role,
      state: "complete",
      source: "persisted",
      timestamp,
      content: [
        { type: role === "assistant" ? "markdown" : "text", text: role === "user" ? at(USER_PROMPTS, index) : at(ASSISTANT_MESSAGES, index) },
        ...(role === "assistant" ? [{ type: "usage" as const, inputTokens: 960 + (index % 500), outputTokens: 180 + (index % 240) }] : []),
      ],
    };
  });
}
