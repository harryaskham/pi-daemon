import { describe, expect, it } from "vitest";
import { parseComposerCommand } from "../components/ConnectedChatPane";

describe("Dash composer command routing", () => {
  it("maps browser built-ins to typed dashboard operations instead of prompting", () => {
    expect(parseComposerCommand("/model provider/model")).toEqual({ operation: "set_model", payload: { modelId: "provider/model" } });
    expect(parseComposerCommand("/thinking high")).toEqual({ operation: "set_thinking_level", payload: { level: "high" } });
    expect(parseComposerCommand("/steer tighten the test")).toEqual({ operation: "steer", payload: { message: "tighten the test" } });
    expect(parseComposerCommand("/follow-up summarize")).toEqual({ operation: "follow_up", payload: { message: "summarize" } });
    expect(parseComposerCommand("/auto-retry off")).toEqual({ operation: "set_auto_retry", payload: { enabled: false } });
    expect(parseComposerCommand("/abort-retry")).toEqual({ operation: "abort_retry", payload: {} });
  });

  it("keeps ordinary text as a normal prompt", () => {
    expect(parseComposerCommand("inspect the active branch")).toEqual({
      operation: "prompt",
      payload: { message: "inspect the active branch" },
    });
  });
});
