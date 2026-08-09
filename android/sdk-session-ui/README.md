# Pi Droid session UI

`sdk-session-ui` is the reusable, Cacophony-neutral session projection and
rendering module. It consumes decoded lifecycle and externally reduced session
state from `sdk-core`; no service bearer, credential handle, transport, Room
schema, process persistence, or app navigation enters this module.

`SessionLifecycleProjection` maps an identity-matched inventory/info/transcript
triple into the existing bounded readonly `SessionSurfaceState`. It rejects
cross-resource identity drift and unavailable transcripts carrying content,
keeps stable deduplicated record keys, and never makes cached data authoritative.
Stable record IDs key a bounded `LazyColumn`, duplicate snapshots replace in
place, and reconnecting/stale/resyncing/offline labels remain explicit.

The module also contains state-driven Rich interactive, TUI, and tree surfaces.
Those composables expose caller-injected intents; they do not open sockets,
request control, send prompts, retry commands, or persist lifecycle state.
Embedding applications connect them to `SessionLifecycleCoordinator` and execute
each returned wire action exactly once. Phone and tablet layouts share the Nord
theme, accessible density, and semantics contract.

Run its tests from the repository root through the collision-free virtual
display wrapper:

```console
env -u DISPLAY nix develop .#android --command \
  android/build-logic/run-with-xvfb.sh \
  ./android/gradlew -p android --no-daemon :sdk-session-ui:test
```

Exact screenshot evidence is opt-in and must remain in the Cacophony session
artifact tree rather than product history:

```console
env -u DISPLAY PI_DROID_SESSION_SCREENSHOT_DIR="$PWD/artifacts/pi-droid-session" \
  nix develop .#android --command \
  android/build-logic/run-with-xvfb.sh \
  ./android/gradlew -p android --no-daemon \
    :sdk-session-ui:test \
    --tests com.harryaskham.pidroid.sessionui.SessionSurfaceScreenshotArtifactTest \
    --rerun-tasks
```
