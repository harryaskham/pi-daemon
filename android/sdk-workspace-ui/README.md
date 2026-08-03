# Pi Droid workspace UI module

This JVM-only Stage A module owns Pi Droid's local workspace state and its
fixture-backed adaptive shell. It deliberately does **not** implement a host,
network transport, live session surface, credential store, Android application,
notification, file transfer, signing, or release path.

## Pure workspace contract

The serializable v2 model is a recursively nested tree of `SplitNode` and
`TabStackNode` values with stable node/tab IDs and opaque leaf targets. Pure
operations cover normalize, split, add/move/close/focus/duplicate/pin, and ratio
resize. Every mutation preserves bounded depth/node/tab/title limits and a valid
focus/active-tab relation.

`WorkspacePersistence` writes deterministic JSON, migrates v1
`selectedTabId`/`SESSION` values, tolerates additive fields within the supported
version, and quarantines malformed, duplicate-ID, or future-version input to one
safe empty pane. The seeded property test executes 2,000 operations with seed
`0x6A0357`.

## Adaptive shell

`WorkspaceAdaptivePolicy` is the only phone/tablet/foldable breakpoint and hinge
source. Compose receives the resolved layout plus `WorkspaceShellState`; it does
not duplicate normalization, focus, close, restore, or visibility decisions.
The renderer supplies:

- a phone-focused pane with an accessible navigation drawer control;
- a tablet/foldable recursive split projection with collapsible sidebar/rail;
- an explicit fold hinge gutter and deterministic content regions;
- scrollable tabs, 48 dp minimum controls, and 2x large-text metrics;
- stable pane/tab/close/resize content descriptions; and
- visibly labelled, static fixture content with no live session semantics.

The screenshot registry fixes the exact phone, tablet, foldable, nested, and
large-text profiles. Real Compose semantics-tree tests exercise the same
renderer, and the opt-in screenshot test captures the same tagged root.

## Focused verification

From the repository root:

```console
nix develop .#android --command \
  android/build-logic/run-with-xvfb.sh \
  ./android/gradlew -p android --no-daemon :sdk-workspace-ui:test
```

The standard suite asserts behavior and accessibility, not wall-clock timing.
Use the opt-in fixture diagnostics only when collecting a measurement receipt.
