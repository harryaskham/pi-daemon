#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ "${GITHUB_ACTIONS:-}" != 'true' ]]; then
  printf '%s\n' 'KVM capability proof must run inside a GitHub Actions job' >&2
  exit 78
fi

required_environment=(
  RUNNER_TEMP
  RUNNER_NAME
  RUNNER_OS
  RUNNER_ARCH
  GITHUB_RUN_ID
  GITHUB_RUN_ATTEMPT
  GITHUB_REPOSITORY
  GITHUB_OUTPUT
)
for name in "${required_environment[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    printf '%s is required for an auditable Actions KVM proof\n' "$name" >&2
    exit 78
  fi
done

device="${PI_DROID_KVM_DEVICE:-/dev/kvm}"
if [[ "$device" != '/dev/kvm' && "${PI_DROID_KVM_TEST_FIXTURE:-}" != '1' ]]; then
  printf '%s\n' 'KVM proof device overrides are fixture-only' >&2
  exit 64
fi
if [[ ! -e "$device" ]]; then
  printf 'KVM device is absent in Runner.Worker context: %s\n' "$device" >&2
  exit 69
fi
if [[ ! -c "$device" ]]; then
  printf 'KVM path is not a character device in Runner.Worker context: %s\n' "$device" >&2
  exit 65
fi
if [[ ! -r "$device" || ! -w "$device" ]]; then
  stat -Lc 'KVM device denied in Runner.Worker context: type=%F mode=%a uid=%u gid=%g major=%t minor=%T' "$device" >&2
  exit 77
fi

receipt="${PI_DROID_KVM_RECEIPT_FILE:-$RUNNER_TEMP/pi-droid-kvm-capability/receipt.json}"

python3 - "$device" "$receipt" <<'PY'
import fcntl
import grp
import json
import os
import pathlib
import pwd
import stat
import sys
from datetime import datetime, timezone

KVM_GET_API_VERSION = 0xAE00
EXPECTED_KVM_API_VERSION = 12

device = pathlib.Path(sys.argv[1])
receipt = pathlib.Path(sys.argv[2])
runner_temp = pathlib.Path(os.environ["RUNNER_TEMP"]).resolve()
receipt_parent = receipt.parent.resolve()
try:
    receipt_parent.relative_to(runner_temp)
except ValueError:
    print("KVM capability receipt must stay under RUNNER_TEMP", file=sys.stderr)
    raise SystemExit(64)

try:
    descriptor = os.open(device, os.O_RDWR | os.O_CLOEXEC)
except OSError as error:
    print(f"Runner.Worker could not open KVM read/write: errno={error.errno}", file=sys.stderr)
    raise SystemExit(77)
try:
    api_version = fcntl.ioctl(descriptor, KVM_GET_API_VERSION, 0)
except OSError as error:
    print(f"Runner.Worker KVM ioctl failed: errno={error.errno}", file=sys.stderr)
    raise SystemExit(65)
finally:
    os.close(descriptor)

if api_version != EXPECTED_KVM_API_VERSION:
    print(f"unexpected KVM API version: {api_version}", file=sys.stderr)
    raise SystemExit(65)

metadata = device.stat()
group_ids = os.getgroups()
group_names = []
for group_id in group_ids:
    try:
        group_names.append(grp.getgrgid(group_id).gr_name)
    except KeyError:
        group_names.append(str(group_id))

payload = {
    "schemaVersion": 1,
    "capability": "android-kvm",
    "readyForLabel": True,
    "runner": {
        "name": os.environ["RUNNER_NAME"],
        "os": os.environ["RUNNER_OS"],
        "arch": os.environ["RUNNER_ARCH"],
        "uid": os.getuid(),
        "gid": os.getgid(),
        "user": pwd.getpwuid(os.getuid()).pw_name,
        "groupIds": group_ids,
        "groupNames": group_names,
    },
    "device": {
        "path": str(device),
        "mode": format(stat.S_IMODE(metadata.st_mode), "04o"),
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
        "major": os.major(metadata.st_rdev),
        "minor": os.minor(metadata.st_rdev),
        "apiVersion": api_version,
    },
    "github": {
        "repository": os.environ["GITHUB_REPOSITORY"],
        "runId": os.environ["GITHUB_RUN_ID"],
        "runAttempt": os.environ["GITHUB_RUN_ATTEMPT"],
    },
    "verifiedAt": datetime.now(timezone.utc).isoformat(),
}

receipt_parent.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(receipt_parent, 0o700)
temporary = receipt.with_suffix(receipt.suffix + ".tmp")
with temporary.open("x", encoding="utf-8") as target:
    json.dump(payload, target, separators=(",", ":"), sort_keys=True)
    target.write("\n")
os.chmod(temporary, 0o600)
os.replace(temporary, receipt)
PY

chmod 600 "$receipt"
{
  printf '%s\n' 'android_kvm_ready=true'
  printf 'receipt=%s\n' "$receipt"
  printf 'runner_name=%s\n' "$RUNNER_NAME"
} >> "$GITHUB_OUTPUT"
printf 'KVM capability verified in Runner.Worker context: runner=%s os=%s arch=%s api=12\n' \
  "$RUNNER_NAME" "$RUNNER_OS" "$RUNNER_ARCH"
