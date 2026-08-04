# Pi Droid early internal application

`com.harryaskham.pidroid` is a trusted-tailnet Pi Daemon client. It registers
hosts manually or from the stable ASCII/QR envelope, stores service bearers as
Android-Keystore AES-GCM ciphertext under `noBackupFilesDir`, and projects
authenticated capabilities, multi-host inventory, information and transcript
state into canonical session surfaces.

The currently released Play internal version 2 remains readonly. Current source
adds the next opt-in interactive milestone: every live connection attaches as an
observer, explicit control grant is required before mutation, command identity is
unique and bounded, and a missing response becomes indeterminate rather than
being replayed. Rich, bounded tree and canonical server-TUI presentations share
the exact host/session/generation authority. This source is not version 3 and
must not be signed or uploaded until the disposable physical proof passes.

The module is excluded from ordinary Gradle settings and the Android fast lane.
Enable it only with `-PpiDroidAndroidApp=true` inside the pinned
`nix develop .#androidRelease` shell. The committed `android/release.properties`
records the current monotonic Play identity as version code 2 and release name
`0.3.0-internal.2`; every later AAB must increment the code.

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
    --version-code 2 \
    --version-name 0.3.0-internal.2 \
    --artifacts "$PWD/pi-droid-release" \
    --prepare-only

PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE="$HOME/.ssh/caco" \
  nix develop .#androidRelease --command \
  android/build-logic/release-internal.sh \
    --version-code 2 \
    --version-name 0.3.0-internal.2 \
    --artifacts "$PWD/pi-droid-release" \
    --upload-prepared
```

Preparation validates bundletool structure, package/version, JAR signature and
the exact release certificate, then installs a universal APK on a dynamically
ported KVM emulator and waits for the registration/workspace accessibility
marker before taking phone/tablet/wide screenshots. The separate
`live-readonly-proof.sh` uses only a random private disposable bearer and
ApiServer, then proves emulator capabilities/inventory/info/transcript,
observer attach, offline cache and a different host incarnation after restart.
`live-interactive-proof.sh` adds an explicitly interactive disposable host and
proves observer denial, controller grant, one uniquely correlated prompt,
redacted tree, TUI snapshot, in-flight disconnect to indeterminate, restart and
a new unique prompt. It retains phone/tablet screenshots, bounded video and
hashed daemon/app diagnostics; an architecture mismatch fails before an
unbounded ADB wait. Upload uses Gradle Play Publisher's `IGNORE`
resolution for idempotent version-code retries, targets only `internal`, commits
no wider rollout, and opens a separate read edit to verify the highest remote
version and track.

Retained evidence is the signed AAB, R8 mapping, exact APK screenshots,
`sha256sums.txt`, a local build receipt, and a remote Play edit/version receipt.
Those binary artifacts belong in Cacophony session or CI artifact storage, never
product history.
