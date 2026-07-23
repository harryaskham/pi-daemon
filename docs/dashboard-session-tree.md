---
title: Dash session-tree navigation
---

# Dash session-tree navigation

Dash Rich panes expose the complete persisted Pi conversation tree without
flattening sibling branches into one false transcript. The active transcript
continues to follow only Pi's authoritative current leaf; opening or filtering
the tree is read-only until the controller explicitly chooses an action.

## Projection and bounds

The browser requests stock Pi `get_tree` over its existing authenticated Rich
channel. It validates the nested response before rendering:

- entry IDs are unique and bounded;
- nested parents must match every entry's `parentId`;
- the reported active leaf must exist;
- node count is capped at 10,000 and depth at 256;
- aggregate projected text is capped at 2 MiB;
- labels/timestamps and message snippets are bounded; and
- cycles, duplicate children, missing parents, unknown container fields, and
  malformed timestamps fail closed.

The resulting model retains parent/children IDs, depth, branch points, labels,
entry type/role/timestamp, user text eligible for edit-resubmit, and two separate
facts: `onActivePath` and `activeLeaf`. A depth-first row array is only a
virtualization index; it does not change conversation semantics.

Filters search bounded label/type/role/snippet text and can select labeled rows,
branch points, entry types, or recent timestamps. Matching rows retain their
ancestors so branch context stays visible. The 10,000-row acceptance fixture is
prepared under 250 ms and the React viewport renders only visible rows.

## Browser interaction

The tree is a keyboard-accessible virtual `tree`/`treeitem` surface:

- Up/Down selects adjacent visible rows;
- Left selects the parent;
- Right selects the first child;
- Home/End selects the first/last visible row;
- Enter compares the selected branch with the active leaf; and
- Escape closes the navigator.

Rows publish `aria-level`, selected state, expanded/child state, and exact active
leaf state. Side-by-side comparison finds the common ancestor and renders only
the two divergent paths. Search, labels, timestamps, branch counts, preview
selection, and comparison are read-only and available to observers.

The pane can hand the same logical session to the canonical TUI presentation at
any time. Shadow TUI remains the fidelity path for extension components and
terminal interaction; Rich tree state never becomes a second JSONL writer.

## Mutations and controller authority

Mutation buttons require the current Rich-channel controller and exact
host/session/generation identity:

- **Fork here** uses stock Pi `fork` at the selected entry.
- **Edit & resubmit** forks before a selected user message, then copies Pi's
  returned editor text into the existing composer. No prompt is sent until the
  operator edits and submits normally.
- **Clone active** uses stock Pi `clone` at the authoritative leaf.
- **Navigate here** changes the active leaf in the same session file.
- **Summarize & navigate** asks Pi to summarize the abandoned branch first,
  with optional bounded instructions and label, then navigates.

Fork, clone, and navigate use fresh idempotency keys per explicit click. A
cancelled action leaves the tree unchanged. Successful actions reload
`get_tree`; append/fork/switch events mark an open tree stale until refreshed.
Disconnected or timed-out remote mutations are indeterminate and are never
blindly replayed.

## Framed in-place navigation extension

Pi's stock 31-command RPC union has `get_tree`, `fork`, and `clone`, but does not
expose `AgentSession.navigateTree()`. Pi Daemon therefore keeps raw `pi-rpc.v1`
exact and adds one capability-gated frame only to `pi-daemon-rpc.v1`:

```json
{
  "kind": "tree_navigate",
  "correlationId": "tree-navigation-01",
  "request": {
    "entryId": "entry-user-01",
    "summarize": true,
    "customInstructions": "Summarize abandoned work.",
    "label": "abandoned-review"
  }
}
```

The response is a private, non-replayed `tree_navigate_result` carrying either a
bounded result or typed error. The attachment verifies controller role and
in-flight capacity before calling the transport-neutral controller method. The
method validates entry/instruction/label bounds, runs through the daemon-wide
turn scheduler (summary generation can call a model), and returns only
cancel/abort state, bounded editor text, and summary entry ID. The generation is
already fixed by the authenticated attachment.

Neutral service capabilities advertise optional `resources.treeNavigation`.
Remote backends add the Dashboard `navigate_tree` operation only when that bit
is present, so an older compatible daemon continues to offer read-only tree,
fork, and clone without receiving an unsupported frame. Browser controls follow
the same negotiated operation list.

The frame schema and frozen examples are published in
[`session-api.schema.json`](../session-api.schema.json),
[`rpc.tree-navigate.frame.json`](../fixtures/session-api/rpc.tree-navigate.frame.json),
and
[`rpc.tree-navigate-result.frame.json`](../fixtures/session-api/rpc.tree-navigate-result.frame.json).
