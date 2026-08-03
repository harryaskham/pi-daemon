# Pi Droid early internal application

`com.harryaskham.pidroid` is currently a deliberately narrow fixture-shell
vertical slice. It renders the canonical recursive workspace source, saves only
its deterministic local workspace JSON, adapts across phone/tablet/wide windows,
and requests no `INTERNET` permission. It does not yet connect to Pi Daemon or
carry host credentials, controller commands, notifications, files, or other
live-session authority.

The module is excluded from ordinary Gradle settings and the Android fast lane.
Enable it only with `-PpiDroidAndroidApp=true` inside the pinned
`nix develop .#androidRelease` shell. The committed `android/release.properties`
starts the monotonic Play identity at version code 1 and release name
`0.3.0-internal.1`; every later AAB must increment the code.

## Secret-safe internal release

`android/build-logic/release-internal.sh` accepts only a SOPS age identity file
or an SSH private-key file that `ssh-to-age` converts inside a mode-0700 temporary
directory. It verifies the preregistered certificate before Gradle, passes
keystore/password/service-account material through private files, and removes
the temporary tree on every exit. No secret value is accepted through argv,
Gradle properties, logs, or retained artifacts.

The manual workflow and operator path deliberately separate preparation from
Play mutation:

```console
PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE="$HOME/.ssh/caco" \
  nix develop .#androidRelease --command \
  android/build-logic/release-internal.sh \
    --version-code 1 \
    --version-name 0.3.0-internal.1 \
    --artifacts "$PWD/pi-droid-release" \
    --prepare-only

PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE="$HOME/.ssh/caco" \
  nix develop .#androidRelease --command \
  android/build-logic/release-internal.sh \
    --version-code 1 \
    --version-name 0.3.0-internal.1 \
    --artifacts "$PWD/pi-droid-release" \
    --upload-prepared
```

Preparation validates bundletool structure, package/version, JAR signature and
the exact release certificate, then installs a universal APK on a dynamically
ported KVM emulator and waits for the fixture accessibility marker before taking
phone/tablet/wide screenshots. Upload uses Gradle Play Publisher's `IGNORE`
resolution for idempotent version-code retries, targets only `internal`, commits
no wider rollout, and opens a separate read edit to verify the highest remote
version and track.

Retained evidence is the signed AAB, R8 mapping, exact APK screenshots,
`sha256sums.txt`, a local build receipt, and a remote Play edit/version receipt.
Those binary artifacts belong in Cacophony session or CI artifact storage, never
product history.
