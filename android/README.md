# Pi Droid build scaffold

This directory contains the Stage A build and generated-contract foundation for
Pi Droid. It deliberately builds only pure JVM modules in the ordinary fast
lane. There is no application UI, Android SDK download, emulator, APK, AAB,
signing-key materialization, or Play upload in this scaffold.

## Pinned toolchain

- Gradle wrapper: 9.6.1, with the distribution SHA-256 pinned in
  `gradle/wrapper/gradle-wrapper.properties`
- Kotlin: 2.4.10
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
nix develop .#android --command ./android/gradlew -p android --no-daemon check
```

The generator is offline and deterministic. It reads the ten declared public
JSON Schema/OpenAPI inputs plus every JSON fixture, resolves local and declared
cross-schema `$ref`/`allOf` object fields, emits Pi RPC command types from the
canonical fixture, and records SHA-256 for every input. Unsupported conditional
schema forms remain authoritative in JSON Schema and are emitted as explicit
diagnostics rather than silently flattened. Generated object metadata splits
known and additive fields so future fields can round-trip without loss.

## Module boundary

Only `sdk-core` and `sdk-testing` participate in the fast JVM build today.
The application and Android UI/integration modules are reserved below for their
separate implementation beads; no placeholder feature code is compiled here.
