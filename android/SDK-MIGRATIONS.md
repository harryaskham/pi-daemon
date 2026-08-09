# Pi Droid Android SDK publication and migrations

## `0.3.0-alpha.2`

Additive session-lifecycle and host-registry revision
(`session-lifecycle-host-registry-v1`). No Maven coordinate or release archive
from the earlier alpha has been published, but the version is advanced so source
consumers can pin this exact contract.

Session lifecycle additions in `core`:

- `PiDaemonClient` now discovers configured session defaults, lists and reads
  retained sessions, creates only from the daemon-advertised canonical cwd/model/
  resource defaults, reads and explicitly reconciles durable tickets, lists
  Dashboard inventory, reads info/transcripts, verifies existing managed-session
  adoption, and requests capability-gated `reuse` activation.
- configured create and activation require caller-owned request and idempotency
  identities. The SDK never invents a cwd, exposes bearer bytes, starts/stops a
  daemon, or automatically retries an accepted or indeterminate mutation.
- observer attach is authorized by the exact decoded transcript identity and
  availability/freshness evidence. TUI attach is capability and dimension gated.
  The original three-argument `attach` descriptor remains available; the new
  overload makes retained-session hydration explicit.
- `SessionLifecycleCoordinator` provides content-free process-resume snapshots,
  unique connection attempts and correlation IDs, explicit control actions,
  stale-attempt rejection, replay-gap resynchronization, and loss-to-
  `INDETERMINATE` semantics with `canReplay=false`. `SessionResumeSnapshotCodec`
  is the strict one-MiB persistence format; it rejects unknown/content-bearing
  fields, while the embedding app owns atomic storage and deletion.
- `session-ui` adds `SessionLifecycleProjection`, which maps decoded lifecycle
  resources into the existing bounded readonly Rich state. Applications still
  own transport, persistence, navigation, and command execution.

The same alpha intentionally carries the coordinated additive editable-host and
credential-replacement boundary in `core`; neither feature weakens credential
lifetime or adds a bearer getter.

Pre-publication `workspace-ui` baseline sync:

- PR #57 added the public daily-driver adaptive layout, destination/session
  inventory models, endpoint policy, theme/status/navigation primitives, and
  deterministic screenshot showcase used by the Pi Droid app.
- These additive classes are part of the alpha.2 AAR and its authoritative
  `javap` baseline. No alpha.2 Maven repository or release archive existed before
  this sync (`previouslyPublished=false`), so no shipped consumer contract is
  being changed or retroactively relabeled.

Coordinates:

- `com.harryaskham.pidroid.sdk:core:0.3.0-alpha.2`
- `com.harryaskham.pidroid.sdk:session-ui:0.3.0-alpha.2`
- `com.harryaskham.pidroid.sdk:workspace-ui:0.3.0-alpha.2`

The Nix archive helper reads this version from `sdk-publication.properties`,
requires any explicit caller override to match it, and verifies the materialized
repository's bounded `metadata/provenance.json` version before naming or archiving
the bundle. A stale helper default therefore cannot mislabel a different Maven
repository version for downstream consumers.

## `0.3.0-alpha.1`

Initial Cacophony-neutral Android SDK bundle.

Pre-publication API baseline sync (`live-readonly-v2`):

- `HostCredentialVault.withBearerSuspending` is an additive suspending callback
  boundary for transport implementations that must use bearer bytes only inside
  an asynchronous request scope.
- `ServiceBearerRequestFactory.http` now accepts a bounded query-pair list before
  body/headers. This changes the JVM method descriptor from the earlier internal
  alpha draft, but no external Maven version containing that draft was released.
  Callers should pass `query = emptyList()` when no query is needed.

`previouslyPublished=false` is part of the reviewed publication metadata: no
Maven coordinate or release archive using this group/version existed before this
baseline sync, and the repository contains no remote publication endpoint.

Coordinates:

- `com.harryaskham.pidroid.sdk:core:0.3.0-alpha.1`
- `com.harryaskham.pidroid.sdk:session-ui:0.3.0-alpha.1`
- `com.harryaskham.pidroid.sdk:workspace-ui:0.3.0-alpha.1`

The bundle is a deterministic local Maven repository archived as a release
asset. It is materialized without configuring the app/signing/Play modules:

```console
./android/gradlew -p android --no-daemon \
  -PpiDroidAndroidSdk=true \
  -PpiDroidSdkRepositoryDir="$PWD/dist/pi-droid-sdk-maven" \
  publishAllPublicationsToSdkBundleRepository
```

Consumers pin the release archive SHA-256 and use the extracted directory as an
ordinary `maven { url = uri(...) }` repository. It requires no package
credentials and must never be supplemented with `mavenLocal()` or dynamic
versions.

`core` exposes neutral host descriptors, HTTP/WebSocket requests, validated
responses/events, and the injected `PiDaemonTransport` interface. The embedding
application owns authentication, TLS, credential lifetime, request factories,
and connection resources. UI modules never request or export bearer bytes.
Localhost is not a security boundary.

`session-ui` exposes the canonical readonly and interactive Rich/TUI/tree/view
surfaces over decoded neutral state. `workspace-ui` exposes the recursive local
workspace model and Compose shell; its desktop fixture entrypoint is excluded.
No SDK artifact contains Cacophony types, app navigation, `sharedUserId`, an
exported bridge, desktop native libraries, or Pi Droid signing/Play state.

Alpha documentation policy: source JARs include KDoc-bearing canonical Kotlin
sources; separate javadoc/Dokka artifacts are intentionally omitted until a
Dokka version is reviewed and pinned. Consumer ProGuard files preserve only
signature/annotation metadata and do not blanket-keep implementation classes.

Compatibility policy:

1. the committed API baseline and binary AAR inspector are authoritative for
   this alpha line;
2. additive public API changes require a new alpha version and migration entry;
3. source/binary-breaking changes require an explicit version change and
   consumer migration notes;
4. POM and Gradle module metadata, AAR and sources JAR checksums, provenance,
   CycloneDX SBOM, and archive checksum are release evidence;
5. no endpoint upload or GitHub release publication occurs without explicit
   release authorization.

Cacophony adoption is tracked separately. It must inject authenticated transport
or use a non-exported UID-checked Binder/app-private Unix bridge; it must not add
a bearer getter, copy credentials between app sandboxes, assume loopback privacy,
or remove existing UI before cross-app screenshot/device parity passes.
