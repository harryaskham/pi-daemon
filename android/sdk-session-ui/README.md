# Pi Droid readonly session UI

`sdk-session-ui` is the reusable, Cacophony-neutral Stage B inventory,
information, and transcript surface. It consumes neutral fixture/cache state
from `sdk-core`; no service bearer, credential handle, transport, Room schema,
or app navigation enters this module.

The surface is intentionally readonly. It contains no composer, prompt,
controller, wake, TUI, tree, extension action, or other Stage C command. Stable
record IDs key a bounded `LazyColumn`, duplicate snapshots replace in place,
and reconnecting/stale/resyncing/offline labels remain explicit. Phone and
tablet layouts share the Nord theme, accessible density, and semantics contract.

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
