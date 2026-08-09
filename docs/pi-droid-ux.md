---
layout: default
title: Pi Droid daily-driver UX
---

# Pi Droid daily-driver UX

Pi Droid's daily-driver shell adapts Pi Daemon's neutral host and session
contracts to Android without adding a mobile transport, authority, or extension
runtime. This document records the reviewed UX contract implemented by
`bd-8e2c2a` from the post-preview-4 daily-driver base.

## Web Dash audit and Android adaptation

The web Dash establishes useful visual grammar: a strong Nord-derived hierarchy,
compact session rail, selected cyan border, explicit live/controller state,
stable transcript/tree/TUI navigation, contextual policy details, and layered
empty/error states. Pi Droid reuses that grammar without copying desktop density.

| Web pattern | Android adaptation |
| --- | --- |
| Persistent left session rail | Horizontal recent cards on phones; persistent 300–324 dp rail on tablets and wide displays |
| Dense top toolbars | 48 dp minimum action targets in a horizontally scrollable action row |
| Transcript/tree/TUI tabs | Transcript, Tree, Terminal, and Extensions destinations with named tab semantics |
| Right-side policy inspector | Wide-only live-safety pane; the same authority/freshness remains visible as chips on smaller screens |
| Hover and pointer detail | Touch-first selected borders, status chips, TalkBack descriptions, and predictable system Back behavior |
| Fixed dark theme | Reviewed Nord dark/light fallbacks plus Android 12+ dynamic color |

The app deliberately shows fewer simultaneous panes than Dash. It prioritizes the
selected session, preserves large touch targets, and lets large font scale reduce
the effective width class rather than squeezing desktop chrome into the same
space.

## Adaptive layout contract

`PiDroidDailyDriverAdaptivePolicy` is a shared JVM contract used by the app and
its deterministic Compose fixtures:

| Effective width | Layout | Session inventory | Context pane |
| --- | --- | --- | --- |
| below 600 dp | phone | horizontal recent cards | hidden |
| 600–999 dp | tablet | 300 dp persistent rail | hidden |
| 1,000 dp and above | wide | 324 dp persistent rail | visible |

Effective width is physical width divided by font scale when font scale exceeds
1.0. Every policy retains a 48 dp minimum touch target. The app uses safe drawing
and IME insets; forms expose Next/Done/Search actions and clear focus on Done.
Content-safe session destination and filter state survive recreation. The
host-management surface is deliberately all memory-only because it also owns
credential forms: its mode, selected identity, endpoint edits, labels,
fingerprints, bearers, and pairing envelopes do not survive process death.
Search queries, session names, and prompt drafts are likewise memory-only.

## Host and endpoint flow

The first-run screen leads with a single **Add a trusted host** task. Manual
endpoint classification is deterministic and happens before submission:

| Endpoint | Result |
| --- | --- |
| `https://…` | encrypted; no extra acknowledgement |
| loopback `http://localhost`, `127.0.0.1`, or `::1` | local development connection; no remote-cleartext acknowledgement |
| other `http://…` | prominent cleartext warning and explicit acknowledgement required |
| missing host, embedded credentials, or another scheme | invalid; connection action disabled |

Bearer and envelope inputs remain masked/content-private, are cleared on submit,
and are never saveable. Pairing-envelope import has a separate remote-HTTP
acknowledgement because the encoded endpoint is not decoded into presentation
state before the registry validates it.

The Hosts surface retains zero/one/many-host behavior: durable default selection,
non-secret edit, atomic re-pair, and confirmed forget. Android Back cancels a
forget dialog first, then returns from edit/add/re-pair to the list, then closes
the host surface. A failed or missing host always leaves a route to another host
or registration.

## Session inventory and state truth

The inventory searches title, project, cwd basename, and state; filters All,
Active, and Unread; and sorts by daemon activity time with deterministic title
and identity tie-breaks. Relative activity labels use exact boundaries from
"Just now" through minutes, hours, days, and a stable UTC month/day label.

Create opens a focused dialog and displays the daemon-advertised cwd,
persistence, model/thinking, tool, project-trust, and system-prompt authority.
The only mobile-provided field is an optional bounded name. Adopt/open keeps the
existing durable activation-ticket and exact-generation behavior.

The UI distinguishes:

- readonly REST, attached readonly RPC, observer, controller/requesting/denied,
  and connection-lost roles;
- fresh, reconnecting, resyncing, stale, offline-cached, and removed freshness;
- working, accepted, completed, failed, and indeterminate session actions;
- explicit reconnect from passive failure.

Accepted and indeterminate requests retain their existing identity. **Check
receipt** and **Reconnect** never issue the original mutation again.

## Session destinations

| Destination | Source and fallback |
| --- | --- |
| Transcript | Canonical readonly or interactive Rich surface; observer connection remains explicit |
| Tree | Exact interactive tree or a truthful observer-required empty state |
| Terminal | Canonical server-side TUI snapshot or a waiting state |
| Extensions | Validated declarative extension surface only; until the live transport supplies one, a truthful unavailable state is shown |

Pi Droid never executes arbitrary project extension code, imports an extension
bundle, or fabricates extension content. Adding the Extensions destination now
removes a navigation dead end while preserving the no-transport-rewrite scope.

## Deterministic proof

The shared `sdk-workspace-ui` fixture uses the same adaptive contract, theme,
status chips, destination bar, inventory grammar, and accessibility semantics as
the app. Pure tests cover width classes, endpoint policy, search/filter/recency,
and relative-time boundaries. Compose tests cover phone, tablet, wide, and
large-text semantics, named controls/states, and 48 dp touch targets.

To write the bounded PNG set and generated contact sheet:

```console
env -u DISPLAY \
  PI_DROID_DAILY_DRIVER_SCREENSHOT_DIR="$PWD/.cacophony/images/bd-8e2c2a" \
  nix develop .#android --command \
  android/build-logic/run-with-xvfb.sh \
  ./android/gradlew -p android --no-daemon \
    :sdk-workspace-ui:test \
    --tests com.harryaskham.pidroid.workspace.DailyDriverUxScreenshotArtifactTest \
    --rerun-tasks
```

The output contains phone, tablet, wide, large-text, and a 2×2 contact-sheet
PNG. These are generated review evidence, not product source; keep them in the
Cacophony session/image artifact tree and do not commit them. Fixtures use only
synthetic host, project, path, and transcript copy. They contain no bearer,
pairing envelope, prompt from a real session, credential, token, or live host
identity.

The conditional Android app remains outside the ordinary JVM gate. The narrow
uncovered-platform smoke is:

```console
nix develop .#androidRelease --command \
  ./android/gradlew -p android -PpiDroidAndroidApp=true \
    :app:compileDebugKotlin :app:testDebugUnitTest
```

This UX pass does not sign, install, upload, contact a live canary, read a token,
or mutate the Play track.
