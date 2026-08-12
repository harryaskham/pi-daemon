---
title: Pi Droid KVM runner qualification
---

# Pi Droid KVM runner qualification

Pi Droid's optional emulator-evidence job may run only on a self-hosted runner
whose actual GitHub `Runner.Worker` process can open `/dev/kvm` read/write and
obtain KVM API version 12. Host-shell probes are not qualification evidence: the
runner service may have a different user, group list, device namespace, WSL
projection, or systemd device policy.

KVM is **not** required to compile, sign, validate, upload, or read back an AAB.
The Play Internal workflow deliberately uses the generic
`self-hosted,nix,x86_64-linux` lane and prepares the signed AAB with
`--skip-emulator`. Runner qualification must not block a release whose separate
product acceptance gates are already satisfied.

## Labels

- `android-kvm-candidate` is temporary routing only. It does **not** claim KVM
  capability. Apply it to exactly one runner while that runner is being tested.
- `android-kvm` is a capability label. Add it only after the candidate's
  Actions-executed proof succeeds and its receipt has been reviewed.
- Remove `android-kvm` immediately if the runner service user, groups, unit,
  namespace, WSL environment, or `/dev/kvm` device mapping changes. Re-prove
  before restoring the label.

Any workflow that requests emulator screenshots or accelerated Android runtime
evidence selects `self-hosted,nix,x86_64-linux,android-kvm` and repeats the KVM
proof before starting the emulator. A stale or incorrect label therefore fails
that evidence lane closed without blocking the independent AAB release lane.

## Qualification procedure

1. Apply only `android-kvm-candidate` to one stopped or idle target runner.
2. Review the runner service configuration, not just an SSH shell:
   - service user and primary/supplementary groups;
   - membership of the group owning `/dev/kvm`;
   - systemd `PrivateDevices`, `DevicePolicy`, and `DeviceAllow` settings;
   - container/user namespace device mappings, if any;
   - WSL kernel and `/dev/kvm` propagation into the runner's distribution and
     service namespace.
3. Make any fix through reviewed, durable service/runtime configuration. Do not
   use a recurring `chmod`, an interactive shell-only group change, or a host
   probe as a substitute for service configuration.
4. Restart the runner service so its process receives the reviewed identity and
   namespace. Dispatch **Pi Droid KVM capability proof** once.
5. The workflow calls `prove-kvm-runner-capability.sh` from the real Actions job.
   It requires a character device that is readable and writable, opens it with
   `O_RDWR`, calls `KVM_GET_API_VERSION`, and accepts only API version 12.
6. Review the uploaded JSON receipt. It contains only runner identity, numeric
   user/group and device metadata, GitHub run identity, and KVM API version; it
   contains no environment dump or release secret.
7. Only after that successful receipt, replace `android-kvm-candidate` with
   `android-kvm`. A failed or missing receipt does not permit promotion.

## Release gate

Runs `31558756854`, `31560683515`, and `31560935109` are preserved failure
evidence. Do not rerun them unchanged. After the five reviewed `google-play-internal` content secrets are present and
the remaining product crash/ANR gates are satisfied, dispatch exactly one new
monotonic Internal release on the generic x86 Nix lane. Retain its signed AAB,
mapping, checksums, and Play commit/readback receipt. KVM receipts and emulator
screenshots are separate evidence when that optional lane is available; they are
not prerequisites for building or releasing the AAB.
