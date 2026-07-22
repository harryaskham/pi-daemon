import {
  EXTENSION_VIEW_PROTOCOL,
  EXTENSION_VIEW_VERSION,
  type ExtensionViewDocument,
  type ExtensionViewResponse,
} from "./extension-view-contract.js";

export function createExtensionViewFixture(): ExtensionViewDocument {
  return {
    protocol: EXTENSION_VIEW_PROTOCOL,
    version: EXTENSION_VIEW_VERSION,
    viewId: "review-fixture-01",
    revision: 2,
    title: "Review bounded changes",
    fallbackText: "Review two changed files and choose whether to continue.",
    capabilities: {
      actions: ["continue", "submit-review"],
      links: "none",
      images: "authorized-blob-only",
    },
    root: {
      type: "stack",
      gap: "normal",
      children: [
        { type: "markdown", text: "## Proposed update\n\nThe extension supplied a server-validated declarative view." },
        { type: "status", tone: "warning", label: "Review required", detail: "No extension code runs in the browser." },
        { type: "code", language: "ts", filename: "fixture.ts", code: "export const safe = true;\n" },
        { type: "diff", language: "diff", diff: "- unsafe\n+ bounded\n" },
        { type: "image", blobRef: "blob:fixture-preview-01", mediaType: "image/png", alt: "Authorized preview", width: 640, height: 360 },
        { type: "key-value", entries: [{ key: "Files", value: "2" }, { key: "Risk", value: "bounded" }] },
        {
          type: "grid",
          columns: 2,
          children: [
            { type: "text", text: "Actions are scoped to this view revision." },
            { type: "action", actionId: "continue", label: "Continue", tone: "primary" },
          ],
        },
        {
          type: "form",
          formId: "review-form",
          submitActionId: "submit-review",
          submitLabel: "Submit review",
          fields: [
            { type: "text", name: "summary", label: "Summary", required: true, placeholder: "Bounded response" },
            {
              type: "select",
              name: "decision",
              label: "Decision",
              required: true,
              options: [
                { value: "approve", label: "Approve" },
                { value: "revise", label: "Request changes" },
              ],
              initial: "approve",
            },
            { type: "boolean", name: "confirmed", label: "I reviewed the fallback", initial: false },
            { type: "multiline", name: "notes", label: "Notes", initial: "" },
          ],
        },
      ],
    },
  };
}

export function createExtensionViewResponseFixture(): ExtensionViewResponse {
  return {
    protocol: EXTENSION_VIEW_PROTOCOL,
    version: EXTENSION_VIEW_VERSION,
    viewId: "review-fixture-01",
    revision: 2,
    actionId: "submit-review",
    values: {
      summary: "Looks safe",
      decision: "approve",
      confirmed: true,
      notes: "Proceed with bounded rendering.",
    },
  };
}
