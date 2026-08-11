// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { TranscriptMessageRecord, TranscriptToolRecord } from "@harryaskham/pi-daemon/dashboard-contract";
import { RichTranscriptRecord } from "../components/RichTranscriptRecord";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<{ root: ReturnType<typeof createRoot>; container: HTMLElement }> = [];

afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

function mountedRoot() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  return { root, container };
}

const tool: TranscriptToolRecord = {
  recordId: "tool:settings",
  key: { toolCallId: "settings" },
  kind: "tool",
  toolName: "bash",
  state: "success",
  source: "persisted",
  arguments: { command: "printf settings" },
  content: [{ type: "text", text: "settings output" }],
};

function reasoning(state: TranscriptMessageRecord["state"], source: TranscriptMessageRecord["source"]): TranscriptMessageRecord {
  return {
    recordId: source === "live" ? "message:reasoning" : "entry:reasoning",
    key: { entryId: "reasoning-entry", messageId: "reasoning" },
    kind: "message",
    role: "assistant",
    state,
    source,
    content: [{ type: "thinking", text: "Inspect semantic identity." }],
  };
}

describe("rich transcript expansion preferences", () => {
  it("opens tool details when expandTools changes without remounting the card", async () => {
    const { root, container } = mountedRoot();
    await act(async () => root.render(<RichTranscriptRecord record={tool} expandTools={false} />));
    expect(container.querySelector('button[aria-expanded="false"]')).not.toBeNull();
    expect(container.querySelector(".bash-command")).toBeNull();

    await act(async () => root.render(<RichTranscriptRecord record={tool} expandTools />));
    expect(container.querySelector('button[aria-expanded="true"]')).not.toBeNull();
    expect(container.querySelector(".bash-command code")?.textContent).toBe("printf settings");
    await act(async () => root.render(<RichTranscriptRecord record={tool} expandTools={false} />));
    expect(container.querySelector('button[aria-expanded="false"]')).not.toBeNull();
    expect(container.querySelector(".bash-command")).toBeNull();
  });

  it("opens persisted reasoning by preference and keeps streamed expansion through reconciliation", async () => {
    const first = mountedRoot();
    await act(async () => first.root.render(<RichTranscriptRecord record={reasoning("complete", "persisted")} expandThinking={false} />));
    expect(first.container.querySelector(".thinking-block")?.hasAttribute("open")).toBe(false);
    await act(async () => first.root.render(<RichTranscriptRecord record={reasoning("complete", "persisted")} expandThinking />));
    expect(first.container.querySelector(".thinking-block")?.hasAttribute("open")).toBe(true);
    await act(async () => first.root.render(<RichTranscriptRecord record={reasoning("complete", "persisted")} expandThinking={false} />));
    expect(first.container.querySelector(".thinking-block")?.hasAttribute("open")).toBe(false);

    const second = mountedRoot();
    await act(async () => second.root.render(<RichTranscriptRecord record={reasoning("streaming", "live")} expandThinking={false} />));
    expect(second.container.querySelector(".thinking-block")?.hasAttribute("open")).toBe(true);
    await act(async () => second.root.render(<RichTranscriptRecord record={reasoning("complete", "persisted")} expandThinking={false} />));
    expect(second.container.querySelector(".thinking-block")?.hasAttribute("open")).toBe(true);
    expect(second.container.textContent).toContain("Inspect semantic identity.");
  });
});
