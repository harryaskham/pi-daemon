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
the minimal x86_64 AOSP `default` system image/emulator, JDK 21, bundletool,
SOPS and ssh-to-age. The same image is exposed as
`packages.<system>.android-test-system-image`, and the Linux flake check opens
that package closure and verifies its API, tag, ABI, and package metadata. It is
the only shell that accepts the Android SDK license and unfree packages,
following explicit operator approval; ordinary shells retain their free-package
policy. See `app/README.md` for the two-phase signed internal release command and
evidence contract.

### Diagnostic-only emulator readiness

The readiness diagnostic exercises only a fresh x86_64 emulator and its
run-scoped ADB server. It does not run npm or Gradle, build or install Pi Droid,
start Pi Daemon, or read a Pi bearer. The destination must be an empty,
owner-private evidence directory:

```console
nix develop .#androidRelease --command \
  android/build-logic/emulator-readiness-diagnostic.sh \
  --artifacts "$PWD/artifacts/emulator-readiness"
```

The deadline remains bounded to 240 seconds. Emulator ADB traffic is delayed
until guest boot completion so an early TCP attach cannot strand the accepted
transport offline. Every diagnostic and physical proof reads the same reviewed
`emulator-system-image.json` contract, creates the pinned API 36 AOSP `default`
x86_64 image with the explicit `medium_phone` device profile, and validates its
generated configuration before launch. Omitting `--device` selects avdmanager's
generic 32 MiB VM-heap fallback; on API 36, zygote can run while the
under-provisioned `system_server` never registers ActivityManager. The validated
phone profile provides a 228 MiB VM heap, at least 2 GiB RAM, and multiple
vCPUs; the harness fails closed instead of booting if those resource classes
drift.

The pinned nixpkgs Android catalog contains API 36 `default`, `google_apis`, and
other device images but no `aosp_atd` or `google_atd`, so an Automated Test
Device is not hermetically selectable at this API level. Flake evaluation
asserts that absence and will fail for review if a future catalog pin adds an
ATD. The fallback does not remove a guest requirement: Pi Droid declares only
the Android `INTERNET` permission and its runtime graph uses AndroidX, Compose,
Kotlin serialization, and OkHttp, with no Google APIs, Google Play Services, or
Play Store library or manifest dependency. The Play Publisher plugin and Play
receipt tooling are host-side release concerns and are not loaded by the app in
the emulator. The proofs exercise platform UI/ADB plus loopback HTTP/WebSocket
connectivity, all provided by the AOSP image.

A failure retains only a bounded, sanitized kernel/emulator excerpt, public-key
payload fingerprints, and fixed-enum guest root-console state
(`boot_completed`, `adbd`, zygote, `system_server`, ABI, and uptime). The
private ADB key, raw console output, and raw emulator log remain in the
run-private temporary directory and are destroyed during verified process/port
cleanup.

## External canary device proof

The production-canary-compatible physical path is
`build-logic/external-canary-proof.sh`. Unlike the disposable readonly and
interactive proofs, it starts no Pi Daemon and receives no bearer value through
argv or environment. It accepts only a canonical API origin, an owner-only
regular token file, and an empty private artifact directory. Remote plaintext
HTTP is refused unless `--allow-insecure-http` is present.

Before reading the token file or spending any authenticated request budget, the
harness proves that the checkout has the exact locked TypeScript compiler and a
complete offline `npm ls` dependency graph required by `npm run build:src`.
This gate never installs or repairs packages: prepare a clean reviewed checkout
with `npm ci --ignore-scripts`. Only after that local gate passes does the host
preflight use authenticated bounded GETs to capabilities, inventory, the
selected information resource, and its transcript. The capabilities response
must report `host.ready: true` and
`host.draining: false`; otherwise the helper stops after that first GET, before
inventory/transcript selection, staging, build, emulator, ADB, install, or app
launch. The resulting debug-only one-shot import fences `hostInstanceId` and
`inventoryId`; only a session that remains both `idle` and `resident-idle`, has
no recovery quarantine, and reports an available/current transcript with
`observerAttachAllowed: true` may receive an observer attach. A retained
quarantined or memory-only row is still a successful readonly hydration: its
identity-matched `records: []` resource keeps host listing ready while attach is
suppressed. The installed app renders a dedicated content-free canary surface,
while all content-bearing hydration stays out of screenshots and logs. App-private data and every retained text or binary artifact receive exact
bearer and structured credential-pattern scans on every exit. Uninstall,
run-owned PID termination, and selected emulator/ADB port probes are part of the
receipt. See `app/README.md` for the command and the full evidence contract.

## Readonly session fixture and image proof

`sdk-session-ui` projects the neutral inventory, information, and transcript
fixtures into a Cacophony-neutral readonly `SessionSurface`. It receives decoded
host/cache state only—never a bearer or transport—and exposes no composer,
controller, wake, TUI, tree, or extension command. Stable record keys back a
bounded lazy transcript; unavailable transcript resources must contain no
records, and are rendered as truthful empty readonly state. Reconnecting, stale,
resyncing, and offline cache state remain visible.

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
contains canonical bounded lifecycle-to-Rich projection plus state-driven Rich/TUI/
tree rendering; and `sdk-android-integration`
contains pure notification/background policy plus SDK-event, foreground-service,
and WorkManager ports. Those ports emit content-safe records and lifecycle plans;
they do not own Android components, sockets, or commands. `app` and
`play-receipt` are conditional manual-release modules. The app now binds the
foreground plan to an explicit, non-sticky `dataSync` service whose bounded
poller reads capabilities and retained-session metadata only; widget, floating,
share, and periodic WorkManager lifecycle bindings remain separate release
slices.

`sdk-core` exposes the reusable lifecycle boundary without owning an Android
process: capability-derived configured create, retained-session list/read/adopt,
durable ticket lookup and evidence-backed reconciliation, Dashboard inventory/
info/transcript/activation, observer and TUI attachment, and a pure process-resume
coordinator. The coordinator persists identities and outcomes only—never bearer,
prompt, transcript, result, cwd, or error content—and never replays a command or
accepted mutation after disconnect/process death. Embedding apps inject transport,
identity generation, durable snapshot storage, and the exact-once execution of
returned wire actions.
