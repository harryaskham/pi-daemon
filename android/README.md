# Pi Droid build scaffold

This directory contains the Stage A build, generated-contract, and local
workspace foundation for Pi Droid. The ordinary fast lane remains JVM-only: it
builds the protocol modules plus an immutable recursive workspace model and a
fixture-backed Compose Desktop projection for semantics and visual proof. There
is no Android SDK download, live session UI, emulator, APK, AAB, signing-key
materialization, network transport, or Play upload in this scaffold.

## Pinned toolchain

- Gradle wrapper: 9.6.1, with the distribution SHA-256 pinned in
  `gradle/wrapper/gradle-wrapper.properties`
- Kotlin: 2.4.10
- Compose Multiplatform: 1.11.1, with the Kotlin Compose compiler plugin at
  2.4.10
- Android Gradle Plugin catalog pin for later Android modules: 9.4.0
- Java toolchain: 21, supplied by `nix develop .#android`
- kotlinx.serialization JSON: 1.11.0
- JUnit: 6.1.2

The AGP aliases are pinned but not applied yet. Applying them would turn the
ordinary contract lane into an Android SDK build, which belongs to a later
module owner and the nightly/manual lane.

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

## Module boundary

`sdk-core`, `sdk-testing`, and `sdk-workspace-ui` participate in the fast JVM
build. `sdk-workspace-ui` contains only the local recursive workspace, adaptive
shell policy, non-live fixture renderer, and screenshot harness. The application,
live session UI, Android integration, transport, credentials, and release
modules remain reserved for their separate implementation beads.
