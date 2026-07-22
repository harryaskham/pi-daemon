---
title: Declarative extension views
---

# Declarative extension views

Pi Daemon publishes a **code-free**, versioned extension view contract for Rich
Dash panes while preserving stock Pi RPC dialogs and the shadow-TUI
compatibility path. The contract is additive: clients that do not negotiate
`extensionViews` never receive `extension_view` events and render the required
plain-text fallback instead.

The language-neutral schema is
[`extension-view.schema.json`](../extension-view.schema.json). TypeScript
consumers can import `@harryaskham/pi-daemon/extension-view-contract`.

## Trust boundary

An extension remains server-side code in the Pi runtime trust domain. It does
not send JavaScript, React components, CSS, HTML, commands, URLs, or callbacks
to the browser. The host:

1. admits a future upstream Pi RPC `extension_ui_request` whose method is
   `render_view`;
2. validates and normalizes the complete view before it enters replay memory;
3. attaches host-authored provenance (`transport=pi-rpc`,
   `validator=pi-daemon`, validation outcome, and
   `browserCodeExecution=false`);
4. emits only the normalized document or a bounded plain-text fallback; and
5. accepts a response only from the current Rich-channel controller.

Unknown fields, node kinds, protocol versions, ambient links, URL/data image
sources, duplicate identifiers, undeclared actions, unsafe control characters,
and over-limit trees fail closed. Invalid source content is never forwarded as
an untyped browser payload. A rejected view can expose only its bounded
`fallbackText`, or a host-generated generic fallback when that text is unsafe.

`blobRef` is an opaque `blob:` identifier. A renderer may resolve it only
through an authenticated host-owned blob resolver. The current Dash renderer
shows an authorized-image placeholder; it never fetches an extension-provided
URL.

## Version 1 document

Every document carries exact protocol/version/revision identity and a fallback:

```json
{
  "protocol": "pi-declarative-view",
  "version": "1.0",
  "viewId": "review-01",
  "revision": 2,
  "title": "Review changes",
  "fallbackText": "Review the changes in the compatible TUI.",
  "capabilities": {
    "actions": ["continue"],
    "links": "none",
    "images": "authorized-blob-only"
  },
  "root": {
    "type": "stack",
    "children": [
      { "type": "markdown", "text": "## Two files changed" },
      { "type": "action", "actionId": "continue", "label": "Continue", "tone": "primary" }
    ]
  }
}
```

The allowlist is:

- `text` and safe-rendered `markdown`;
- `code` and `diff` as inert text;
- authenticated opaque-blob `image` placeholders;
- bounded `key-value` tables and semantic `status` blocks;
- recursive `stack` and up-to-four-column `grid` containers;
- view-scoped `action` buttons; and
- `form` nodes with text, multiline, select, and boolean fields.

There are deliberately no raw HTML, style, script, iframe, web component,
network request, terminal input, arbitrary link, or generic JSON-renderer
primitives.

## Capability and input correlation

`capabilities.actions` is a least-authority list scoped to one exact
`viewId`/`revision`. Every declared action must appear exactly once in the tree,
and every rendered action or form submit must be declared. A browser response
returns all four correlation fields:

```json
{
  "protocol": "pi-declarative-view",
  "version": "1.0",
  "viewId": "review-01",
  "revision": 2,
  "actionId": "continue"
}
```

Optional form values are a bounded map of strings and booleans. Responses for a
stale revision or undeclared action are invalid. Dashboard request IDs and
subscription/controller identity provide the outer transport correlation;
view identity never substitutes for those checks.

## Negotiation and bounds

Current capability negotiation reports:

- Rich: native declarative renderer;
- TUI: required plain-text fallback;
- RPC: transport contract;
- browser code execution: false; and
- image sources: authenticated opaque blobs only.

Default limits are 256 KiB encoded view size, 256 nodes, depth 16, 128 KiB
aggregate text, 32 actions, 32 fields, 128 select options, and 16 images. The
validator enforces count, depth, bytes, identifier uniqueness, and per-record
limits before replay or browser delivery. The browser additionally keeps at
most eight current view requests per live pane.

## Upstream Pi proposal

Pi Daemon does not monkey-patch `ExtensionUIContext` and does not reinterpret
`ctx.ui.custom()` component factories. The intended upstream seam is an
additive API such as:

```ts
ctx.ui.renderView(document, { signal, timeout }): Promise<ExtensionViewResponse | undefined>
```

RPC mode would carry it as correlated `extension_ui_request(method=render_view)`
and `extension_ui_response` values. Interactive Pi can render the same
allowlisted model or its mandatory fallback. Until that supported seam lands,
current stock dialogs/widgets continue unchanged; the negotiated contract and
Rich renderer are ready for compatible RPC producers without claiming that
arbitrary Pi components are portable.

Shadow TUI remains the fidelity path for existing interactive components,
custom editors, overlays, terminal input, and extension component factories.
Declarative views complement it; they do not replace it.
