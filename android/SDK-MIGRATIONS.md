# Pi Droid Android SDK publication and migrations

## `0.3.0-alpha.1`

Initial Cacophony-neutral Android SDK bundle.

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
