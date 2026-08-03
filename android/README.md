# Pi Droid build scaffold

This directory contains the Stage A build, generated-contract, and local
workspace foundation for Pi Droid. The ordinary fast lane remains JVM-only: it
builds the protocol modules plus an immutable recursive workspace model and a
fixture-backed Compose Desktop projection for semantics and visual proof. There
is no Android SDK download, interactive or transport-backed session UI,
emulator, APK, AAB, signing-key materialization, network transport, or Play
upload in this scaffold.

## Pinned toolchain

- Gradle wrapper: 9.6.1, with the distribution SHA-256 pinned in
  `gradle/wrapper/gradle-wrapper.properties`
- Kotlin: 2.4.10
- Compose Multiplatform: 1.11.1, with the Kotlin Compose compiler plugin at
  2.4.10
- Android Gradle Plugin: 9.3.1 (current stable; the earlier 9.4.0 scaffold pin
  was still an unpublished preview and could not resolve from Google Maven)
- Java toolchain: 21, supplied by `nix develop .#android`
- kotlinx.serialization JSON: 1.11.0
- JUnit: 6.1.2

AGP and Play publishing are applied only when `-PpiDroidAndroidApp=true` adds
the release-only modules. The ordinary contract lane therefore keeps its exact
JVM-only behavior and never downloads an Android SDK, starts an emulator, signs
an AAB, or contacts Google Play.

## Commands

From the repository root:

```console
node android/build-logic/generate-protocol-models.mjs
node android/build-logic/generate-protocol-models.mjs --check
node --test test/android-contract-generation.test.mjs
nix develop .#android --command bash -c \
  "find android -type f \\( -name '*.kt' -o -name '*.kts' \\) -print0 | xargs -0 ktlint --relative"
nix develop .#android --command \
  android/build-logic/run-with-xvfb.sh \
  ./android/gradlew -p android --no-daemon check
```

The generator is offline and deterministic. It reads the ten declared public
JSON Schema/OpenAPI inputs plus every JSON fixture, resolves local and declared
cross-schema `$ref`/`allOf` object fields, emits Pi RPC command types from the
canonical fixture, and records SHA-256 for every input. Unsupported conditional
schema forms remain authoritative in JSON Schema and are emitted as explicit
diagnostics rather than silently flattened. Generated object metadata splits
known and additive fields so future fields can round-trip without loss.

## Workspace fixture and image proof

`android/build-logic/run-with-xvfb.sh` keeps Linux Compose tests independent of
an ambient desktop. It asks Xvfb for a free display through `-displayfd`, bounds
readiness, validates the result, disables TCP, and traps process/temp cleanup.
The Android Nix shell supplies its exact GL/font/X11 closure.

The same real Compose semantics test runtime can write the four deterministic
phone/tablet/foldable/nested raw PNGs when an explicit output directory is set:

```console
env -u DISPLAY PI_DROID_SCREENSHOT_DIR="$PWD/artifacts/pi-droid-workspace" \
  nix develop .#android --command \
  android/build-logic/run-with-xvfb.sh \
  ./android/gradlew -p android --no-daemon \
    :sdk-workspace-ui:test \
    --tests com.harryaskham.pidroid.workspace.WorkspaceScreenshotArtifactTest \
    --rerun-tasks
```

The output is evidence, not source: keep it in the Cacophony session/image
artifact tree rather than product history. An optional first-frame diagnostic is
available through `PI_DROID_FIXTURE_DIAGNOSTICS=1`; its timing and recomposition
count are measurements, never standard gate bounds.

The separate `nix develop .#androidRelease` shell pins API 36, build-tools 36,
the x86_64 Google APIs system image/emulator, JDK 21, bundletool, SOPS and
ssh-to-age. It is the only shell that accepts the Android SDK license and unfree
packages, following explicit operator approval; ordinary shells retain their
free-package policy. See `app/README.md` for the two-phase signed internal release
command and evidence contract.

## Readonly session fixture and image proof

`sdk-session-ui` projects the neutral inventory, information, and transcript
fixtures into a Cacophony-neutral readonly `SessionSurface`. It receives decoded
host/cache state only—never a bearer or transport—and exposes no composer,
controller, wake, TUI, tree, or extension command. Stable record keys back a
bounded lazy transcript; reconnecting, stale, resyncing, and offline cache state
remain visible.

The same Compose test artifact writes exact 430x932 phone and 1280x800 tablet
proofs only when an output directory is requested:

```console
env -u DISPLAY PI_DROID_SESSION_SCREENSHOT_DIR="$PWD/artifacts/pi-droid-session" \
  nix develop .#android --command \
  android/build-logic/run-with-xvfb.sh \
  ./android/gradlew -p android --no-daemon \
    :sdk-session-ui:test \
    --tests com.harryaskham.pidroid.sessionui.SessionSurfaceScreenshotArtifactTest \
    --rerun-tasks
```

Keep these PNGs in the Cacophony session/image artifact tree, not product
history.

## Module boundary

`sdk-core`, `sdk-testing`, `sdk-workspace-ui`, `sdk-session-ui`, and
`sdk-android-integration` participate in the fast JVM build. `sdk-workspace-ui`
contains local recursive workspace policy and fixture proof; `sdk-session-ui`
contains canonical session projection/rendering; and `sdk-android-integration`
contains pure notification/background policy plus SDK-event, foreground-service,
and WorkManager ports. Those ports emit content-safe records and lifecycle plans;
they do not own Android components, sockets, or commands. `app` and
`play-receipt` are conditional manual-release modules. Real Android lifecycle
bindings and monitoring transport, widgets/floats/share, and real network/storage
implementations remain reserved for separate release slices.
