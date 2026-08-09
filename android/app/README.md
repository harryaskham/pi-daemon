# Pi Droid early internal application

`com.harryaskham.pidroid` is a trusted-tailnet Pi Daemon client. It registers
hosts manually or from the stable ASCII/QR envelope, stores service bearers as
Android-Keystore AES-GCM ciphertext under `noBackupFilesDir`, and projects
authenticated capabilities, multi-host inventory, information and transcript
state into canonical session surfaces.

Google Play internal currently carries version 4 (`0.3.0-internal.4`). Its
exact app source base is commit
`aab5afb39de8e9e7071320268a56eb703d0f0306`, tree
`daf8cf9e639da11b6cba4d1fc072e1f6c64c5ac6`; the release checkout added only
the Play notes, release-harness hardening, and its source contract test. Version
4 includes resilient reconnect and host recovery, canonical bearer connections,
retained app-failure modal evidence, the reviewed external-canary contract, a
clear transcript-unavailable state, and durable editable/forget/re-pair
crash-safe multi-host management. Create/adopt daily-driver polish remains in
progress.

Every live connection attaches as an observer, explicit control grant is
required before mutation, command identity is unique and bounded, and a missing
response becomes indeterminate rather than being replayed. Rich, bounded tree
and canonical server-TUI presentations share the exact
host/session/generation authority. An explicit readonly refresh retires only
idle pooled HTTP connections before hydration, so a replacement daemon at the
same authority can publish its new host identity on the first reviewed refresh.
Automatic request retry remains disabled, active WebSockets are not retired,
and an indeterminate mutation is never replayed during refresh or the separate
interactive reconnect.

The module is excluded from ordinary Gradle settings and the Android fast lane.
Enable it only with `-PpiDroidAndroidApp=true` inside the pinned
`nix develop .#androidRelease` shell. The committed `android/release.properties`
records the current monotonic Play identity as version code 4 and release name
`0.3.0-internal.4`; every later AAB must increment the code.

## Daily-driver host management

The app's **Hosts** surface works with zero, one, or many registered Pi Daemons.
It lists each host's display name, API origin, transport/certificate policy,
readiness, and durable default selection. Users can add another host, edit only
non-secret name/origin/pin metadata, explicitly re-pair to atomically replace the
metadata plus Keystore-backed bearer generation, or forget one host after a
confirmation that names the local state being removed. A failed connection never
hides this surface, and a missing-host view offers another host or registration
instead of crashing an orphaned view.

Duplicate manual or pairing-envelope origins are never silently accepted: the
existing host is shown and the user must choose **Re-pair** to replace its
credentials. Replacement stages a new no-backup ciphertext generation, commits
metadata, then invalidates only that host's sockets/cache and refreshes. A failed
commit removes the staged generation and performs no network operation. Forget
commits metadata removal before destroying local credential authority. Other
hosts, credentials, defaults, and workspaces are preserved. The bearer is masked
while entered, cleared from form/caller buffers on submission, and never enters
host models, SharedPreferences, Room, logs, screenshots, backup, or device
transfer. Clearing application data is not an accepted recovery path.

This registry is intentionally Android-specific: Pi Droid moves among trusted
machines and owns mobile Keystore state, while the browser dashboard uses its
serving daemon's authenticated same-origin authority and the terminal client
uses its explicitly selected local/remote process. The neutral host descriptor
and transport contracts remain shared; Android credential storage and host
navigation are not duplicated into web or TUI presentation code.

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
    --version-code 4 \
    --version-name 0.3.0-internal.4 \
    --artifacts "$PWD/pi-droid-release" \
    --prepare-only

PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE="$HOME/.ssh/caco" \
  nix develop .#androidRelease --command \
  android/build-logic/release-internal.sh \
    --version-code 4 \
    --version-name 0.3.0-internal.4 \
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
unbounded ADB wait. Every success or early exit stops only its owned processes,
scans all retained text for the exact disposable bearer before destroying the
token, and leaves only a safe scan receipt. An unrelated app-failure modal is
never dismissed: the fail-closed path retains owner-private normalized UI XML,
a screenshot, a redacted logcat summary, safe identity class/hash metadata and
content hashes without retaining the raw package, title or logcat text. If any
capture predicate fails, the same owner-private occurrence remains incomplete
and names only that fixed predicate plus the safe identity class/hash and the
status/hashes of bounded components; empty, oversized, unhashable or
permission-unsafe files are discarded. Upload uses Gradle Play Publisher's `IGNORE`
resolution for idempotent version-code retries, targets only `internal`, commits
no wider rollout, and opens a separate read edit to verify the highest remote
version and track.

### Reviewed external-canary readonly proof

`external-canary-proof.sh` is the only reviewed path for installing the debug
app against an already-running Pi Daemon canary. It accepts a canonical base API
URL and the path to an owner-owned regular token file; plain remote HTTP also
requires the explicit `--allow-insecure-http` acknowledgement.

```console
nix develop .#androidRelease --command \
  android/build-logic/external-canary-proof.sh \
    --api-url https://pi.example.test \
    --token-file "$HOME/.local/state/pi-daemon/instance/api-token" \
    --artifacts "$PWD/artifacts/pi-droid-external-canary"
```

The harness performs four authenticated, bounded `GET` requests only:
capabilities, inventory, information, and transcript. The capabilities GET is a
hard readiness gate: unless it reports `host.ready: true` and
`host.draining: false`, no inventory/transcript selection or later device work
occurs. It records the exact host incarnation and first inventory identity, then
fences the app to both identities.
An observer socket is permitted only when the same managed session remains
`idle` and `resident-idle` in both inventory and information; otherwise readonly
REST hydration proceeds with no observer attach. The canary UI contains only
content-free proof markers and exposes no refresh, control, prompt, create,
update, delete, or restart action.

The service bearer never enters an intent, process argument, environment value,
terminal output, retained log, or screenshot. A private host process builds the
canonical pairing envelope, streams it over ADB stdin into the debug app's fixed
`noBackupFilesDir` staging name, and the app deletes that one-shot file while
consuming it. The import metadata exists only in the debug manifest. The release
manifest still disables backup and device transfer, while the accepted
credential is Android-Keystore ciphertext in no-backup storage.

Every success and failure path streams the app-private sandbox through an exact
bearer plus structured-pattern scanner before uninstall, stops only the
run-owned emulator and private ADB server, verifies their PIDs and selected ports
are gone, and repeats the scan over all retained text and binary artifacts.
Success retains a content-free screenshot, bounded app logcat, preflight and
cleanup receipts, scan receipts, and SHA-256s. The harness never starts, stops,
or restarts the target Pi Daemon. Do not improvise a deep-link, clipboard, shell
argument, environment variable, or pairing-envelope alternative for production
canaries.

Version 4 was uploaded on 2026-08-09 only to the completed Play `internal`
track. Verification edit `08236353605814851857` confirmed it as the highest
remote version while preserving versions 1–3. The exact AAB SHA-256 is
`f09a810c501e900011ebaa4c6fb0eb8039abbefabece2a9a1d045843b8029775`, the R8
mapping SHA-256 is
`deae7b97e8ba575c9aee40523787d895a30fd8e046b33f1de54b9328fb3dfa21`, and the
published release-notes SHA-256 is
`ea638b8eb891399e5a31d88000b9f1f7451a18641fd43139d173c581ca9b0387`.

Retained evidence is the signed AAB, R8 mapping, exact APK screenshots,
`sha256sums.txt`, a local build receipt, and a remote Play edit/version receipt.
Those binary artifacts belong in Cacophony session or CI artifact storage, never
product history.
