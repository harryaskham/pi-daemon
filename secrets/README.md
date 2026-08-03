# Pi Droid encrypted release material

This directory may contain only SOPS-encrypted release material and public
operator metadata. Never commit decrypted keystores, passwords, service-account
JSON, Gradle signing properties, or age private keys.

`android-play-upload.sops.yaml` is copied from the established android-utils Play
release material and remains encrypted to the recipients declared in the
repository root `.sops.yaml` (Harry, Caco, and Caco Work).

Expected encrypted fields:

- `play_keystore_base64`
- `play_key_alias`
- `play_store_password`
- `play_key_password`
- `play_service_account_json`

Pi Droid identity:

- application ID: `com.harryaskham.pidroid`
- Play track: `internal`
- expected release certificate SHA-256:
  `FA:58:80:A7:C9:6D:F8:7B:B4:63:7D:18:58:7E:32:F6:CD:F6:95:06:52:34:FE:54:95:E2:4F:ED:12:1E:CE:4C`

The fingerprint was verified on 2026-08-03 using the operator's `~/.ssh/caco`
identity converted with the pinned Nix `ssh-to-age` tool, SOPS extraction into a
mode-0700 temporary directory, and the pinned JDK 17 `keytool`. Only the SHA-256
fingerprint was printed; temporary plaintext was removed by a shell trap.

Release automation must materialize secrets into a fresh private temporary
directory, use environment/file indirection that keeps passwords and key bytes
out of argv/logs/Nix store values, verify the certificate before Gradle runs,
and delete the directory on success, failure, or cancellation. Google Play
service-account credentials must be scoped to the upload step only.
