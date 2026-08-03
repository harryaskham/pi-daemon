# Pi Droid Android widget, link, and Share module

`sdk-android-ui` is a conditional Android library for Stage-E operating-system
surfaces. It is included only with `-PpiDroidAndroidApp=true`, so the ordinary
protocol/Compose JVM lane does not download an Android SDK.

The module owns:

- credential-free pinned and collection widget selections/projections;
- stale/age labels and fresh-authority gates for interactive widget intents;
- app-owned `pidroid://host/<id>/session/<id>` links and bounded dynamic shortcuts;
- exact `ACTION_SEND`/`ACTION_SEND_MULTIPLE` text, URL, and fitting-image MIME filters;
- streamed image admission against source/base64/frame bounds;
- SHA-256 content identity and encrypted, TTL-bounded staging under
  `Context.noBackupFilesDir` without retaining provider URIs;
- cancel, partial-write, failure, and process-recreation cleanup.

It does not own notifications, foreground monitoring, live transport, Stage-C
session/TUI code, floating overlays, credentials, signing, Play workflows, or a
generic file/blob API. Widget rows open Pi Droid for repository/controller
revalidation; the widget process never dispatches a command directly.

Pure model tests can run through the repository JVM compiler without Android
classes. The canonical Android gate uses the release shell and explicit property:

```console
nix develop .#androidRelease --command \
  ./android/gradlew -p android --no-daemon -PpiDroidAndroidApp=true \
    :sdk-android-ui:testDebugUnitTest :sdk-android-ui:lintDebug
```

Emulator/device acceptance must cover widget selection/recreation/stale labels,
collection rows, saved and unknown deep links, Share chooser text/URL/fitting
images, oversized/generic-file rejection, and TTL cleanup. Screenshot/video
artifacts stay in the session summary surface rather than product history.
