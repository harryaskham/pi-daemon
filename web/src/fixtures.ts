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
    const sourceKind = index !== 0 && index % 11 === 0
      ? "external"
      : index !== 0 && index % 13 === 0
        ? "imported"
        : index % 19 === 0
          ? "memory"
          : "managed";
    const managed = sourceKind === "managed" || sourceKind === "memory";
    return {
      inventoryId: inventoryId(index),
      sourceKind,
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
      ...(managed
        ? {
            managed: {
              sessionId,
              generation,
              revision: 1 + (index % 8),
              residency: runtime === "dormant" ? "dormant" as const : "resident" as const,
              state: runtime === "running" ? "running" as const : runtime === "failed" ? "failed" as const : "idle" as const,
            },
          }
        : {}),
      activation: managed
        ? { eligible: true, modes: ["reuse", "fork"] }
        : { eligible: true, modes: ["direct", "fork", "preview-only"] },
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
  return Array.from({ length: count }, (_, index): TranscriptRecord => {
    const id = entryId(index);
    const timestamp = new Date(Date.now() - (count - index) * 28_000).toISOString();
    if (index % 53 === 7) {
      return {
        recordId: `summary:${id}`,
        key: { entryId: id },
        kind: "summary",
        summaryKind: index % 106 === 7 ? "compaction" : "branch",
        source: "persisted",
        timestamp,
        content: [{ type: "markdown", text: "### Durable context\n\n- Preserved the active branch and normalized Pi entry IDs.\n- Deferred large tool output behind a bounded preview." }],
      };
    }
    if (index % 59 === 9) {
      return {
        recordId: `custom:${id}`,
        key: { entryId: id },
        kind: "custom",
        customType: index % 118 === 9 ? "extension:status" : "session:checkpoint",
        hidden: index % 118 === 9,
        source: "persisted",
        timestamp,
        data: { fixture: true, bounded: true },
        fallbackText: index % 118 === 9 ? "Extension status retained but hidden from the main transcript." : "A custom checkpoint was retained safely.",
      };
    }
    if (index % 11 === 4) {
      const state = index === count - 2 ? "pending" : index % 37 === 0 ? "error" : index % 23 === 0 ? "running" : "success";
      const toolName = at(["read", "bash", "edit", "write", "grep", "find", "ls", "custom_search"] as const, index);
      const path = `/work/aurora/src/${index % 2 === 0 ? "dashboard.ts" : "theme.css"}`;
      const output = state === "error"
        ? "The bounded fixture reported a recoverable stale cursor."
        : toolName === "edit"
          ? "-const stale = true;\n+const generation = frame.identity.generation;\n+const current = generation === session.generation;"
          : toolName === "bash"
            ? "$ npm run web:test\n✓ transcript reducer 120 rapid updates\n✓ bounded DOM and semantic renderers"
            : toolName === "grep" || toolName === "find" || toolName === "ls"
              ? "web/src/components/RichTranscriptRecord.tsx\nweb/src/transcript-store.ts\nweb/src/test/transcript-store.test.ts"
              : "export const channel = {\n  hydration: \"not-requested\",\n  replay: \"bounded\"\n};";
      return {
        recordId: `tool:${id}`,
        key: { entryId: id, messageId: `message-${id}`, toolCallId: `tool-${id}` },
        kind: "tool",
        toolName,
        state,
        source: state === "running" || state === "pending" ? "live" : "persisted",
        timestamp,
        arguments: {
          title: at(["Read dashboard contract", "Inspect fixture projection", "Apply semantic token patch", "Run focused layout checks"] as const, index),
          path,
          command: "npm run web:test",
          pattern: "DashboardSessionIdentity",
        },
        content: [{ type: state === "error" ? "error" : "text", text: output }],
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
      const events = ["compaction", "model", "thinking", "label", "session-name", "queue", "retry"] as const;
      const event = at(events, index);
      return {
        recordId: `timeline:${id}`,
        key: { entryId: id },
        kind: "timeline",
        event,
        label: event === "compaction" ? "Compaction complete" : event === "retry" ? "Retry settled" : `${event} changed`,
        data: { detail: event === "compaction" ? "Context summarized at a durable entry boundary." : event === "retry" ? "Provider retry completed without duplicating the optimistic message." : "gpt-5.6 · high reasoning" },
        source: "persisted",
        timestamp,
      };
    }
    const role = index % 3 === 0 ? "user" : "assistant";
    const isError = role === "assistant" && index % 71 === 0;
    const markdown = index % 31 === 0
      ? "The reducer keeps **persisted truth** over partial replay.\n\n```ts\nconst current = frame.generation === session.generation;\nif (!current) return state;\n```"
      : at(ASSISTANT_MESSAGES, index);
    return {
      recordId: `entry:${id}`,
      key: { entryId: id, messageId: `message-${id}` },
      kind: "message",
      role,
      state: isError ? "error" : "complete",
      source: "persisted",
      timestamp,
      content: [
        { type: isError ? "error" : role === "assistant" ? "markdown" : "text", text: isError ? "The live stream paused at a replay gap; persisted history remains available." : role === "user" ? at(USER_PROMPTS, index) : markdown },
        ...(role === "user" && index % 43 === 0 ? [{ type: "image" as const, mediaType: "image/png", blobRef: `fixture:image:${id}`, alt: "A bounded dashboard reference image", width: 1280, height: 720 }] : []),
        ...(role === "assistant" ? [{ type: "usage" as const, inputTokens: 960 + (index % 500), outputTokens: 180 + (index % 240), cost: 0.003 + (index % 9) / 10_000 }] : []),
      ],
    };
  });
}

/** A deterministic newest viewport that exercises every production renderer. */
export function createTranscriptShowcaseFixtures(): TranscriptRecord[] {
  const time = (offset: number) => new Date(Date.now() - (8 - offset) * 12_000).toISOString();
  return [
    {
      recordId: "showcase:image",
      key: { entryId: "showcase-image", messageId: "showcase-image-message" },
      kind: "message",
      role: "user",
      state: "complete",
      source: "persisted",
      timestamp: time(1),
      content: [
        { type: "text", text: "Keep the image bounded, accessible, and separate from the trusted blob resolver." },
        { type: "image", mediaType: "image/png", blobRef: "fixture:image:showcase", alt: "Nord Midnight dashboard reference", width: 1440, height: 960 },
      ],
    },
    {
      recordId: "showcase:markdown",
      key: { entryId: "showcase-markdown", messageId: "showcase-markdown-message" },
      kind: "message",
      role: "assistant",
      state: "complete",
      source: "persisted",
      timestamp: time(2),
      content: [
        { type: "markdown", text: "### Generation-safe reducer\n\nPersisted records replace **live partials** by Pi IDs, never rendered text.\n\n```ts\nconst current = frame.identity.generation === session.generation;\nif (!current) return state;\n```\n\n<script data-unsafe>window.__dashUnsafe = true</script>" },
        { type: "usage", inputTokens: 1_248, outputTokens: 264, cost: 0.0042 },
      ],
    },
    {
      recordId: "showcase:edit",
      key: { entryId: "showcase-edit-entry", messageId: "showcase-edit-message", toolCallId: "showcase-edit-tool" },
      kind: "tool",
      toolName: "edit",
      state: "success",
      source: "persisted",
      timestamp: time(3),
      arguments: { path: "web/src/transcript-store.ts", title: "Apply identity merge" },
      content: [{ type: "text", text: "-const key = record.content;\n+const key = transcriptRecordIdentity(record);\n+const current = identityMatches(frame, session);" }],
      details: { durationMs: 42 },
    },
    {
      recordId: "showcase:bash",
      key: { entryId: "showcase-bash-entry", messageId: "showcase-bash-message", toolCallId: "showcase-bash-tool" },
      kind: "tool",
      toolName: "bash",
      state: "running",
      source: "live",
      timestamp: time(4),
      arguments: { command: "npm run web:test", cwd: "/work/aurora" },
      content: [{ type: "text", text: "$ npm run web:test\n✓ semantic markdown and tool renderers\n✓ replay-gap reconciliation\n… bounded stream still running" }],
      details: { durationMs: 318 },
    },
    {
      recordId: "showcase:summary",
      key: { entryId: "showcase-summary-entry" },
      kind: "summary",
      summaryKind: "compaction",
      source: "persisted",
      timestamp: time(5),
      content: [{ type: "markdown", text: "- Retained active-branch identity and controller state.\n- Collapsed large output into authorized previews." }],
    },
    {
      recordId: "showcase:custom",
      key: { entryId: "showcase-custom-entry" },
      kind: "custom",
      customType: "extension:status",
      hidden: false,
      source: "persisted",
      timestamp: time(6),
      data: { status: "ready" },
      fallbackText: "Extension status is available through a safe generic renderer.",
    },
    {
      recordId: "showcase:queue",
      key: { entryId: "showcase-queue-entry" },
      kind: "timeline",
      event: "queue",
      label: "Follow-up queued",
      data: { detail: "One bounded follow-up waits for the active turn to settle." },
      source: "live",
      timestamp: time(6.5),
    },
    {
      recordId: "showcase:custom-tool",
      key: { entryId: "showcase-custom-tool-entry", messageId: "showcase-custom-tool-message", toolCallId: "showcase-custom-tool-call" },
      kind: "tool",
      toolName: "extension_render",
      state: "success",
      source: "persisted",
      timestamp: time(6.7),
      arguments: { title: "Render extension status" },
      content: [{ type: "text", text: "Generic extension output remains visible without executing browser-side extension code." }],
      details: { bounded: true },
    },
    {
      recordId: "showcase:error",
      key: { entryId: "showcase-error-entry", messageId: "showcase-error-message" },
      kind: "message",
      role: "assistant",
      state: "error",
      source: "live",
      timestamp: time(7),
      content: [{ type: "error", text: "A replay gap paused live rendering; persisted history remains safe while the page reconciles." }],
    },
    {
      recordId: "showcase:stream",
      key: { entryId: "showcase-stream-entry", messageId: "showcase-stream-message" },
      kind: "message",
      role: "assistant",
      state: "streaming",
      source: "live",
      timestamp: time(8),
      content: [{ type: "markdown", text: "The normalized stream is reconciled and rendering the newest bounded delta." }],
    },
  ];
}
