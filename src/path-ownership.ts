/**
 * Who may own a path the daemon reads.
 *
 * Forty-one ownership guards across twenty-one modules all compared
 * `info.uid` against `process.getuid()`, and none was exercised by a test: every
 * fixture is created by the process that then loads it, so the comparison is
 * equal by construction and the guard is unreachable end-to-end. Running the
 * suite as another user does not help, because the fixtures move with it.
 *
 * So the decision the guards encode is extracted here and tested directly. The
 * call sites keep their own error types and messages — this module answers only
 * "is this owner acceptable", which is the part that was never checked.
 *
 * Two policies exist, and the split is deliberate rather than drift:
 *
 * - `owner-or-root` for material the system provisions *for* the service:
 *   configuration, TLS material, installed package resources, session defaults.
 *   Root ownership is a normal deployment shape — a Nix store path, a system
 *   configuration file, a Home Manager symlink — and `docs/operations.md`
 *   already documents the configuration case as policy.
 * - `owner-only` for material the service holds as its *own secret*: the API
 *   bearer token, the Pi auth seed, dashboard credentials and descriptors, the
 *   authorization store, and durable session state. A root-owned secret is not
 *   a deployment shape; it means something else wrote it.
 */

/** Acceptable owners for a path, given what the path holds. */
export type PathOwnershipPolicy = "owner-only" | "owner-or-root";

/** Numeric uid of root, accepted only under `owner-or-root`. */
export const ROOT_UID = 0;

/**
 * Whether `ownerUid` may own a path held under `policy`.
 *
 * `currentUid` is `process.getuid?.()`. Platforms without uids report
 * `undefined`, where the check is not meaningful and cannot fail closed on a
 * quantity that does not exist; every call site already behaved this way.
 */
export function isPermittedPathOwner(
  ownerUid: number,
  policy: PathOwnershipPolicy,
  currentUid: number | undefined,
): boolean {
  if (currentUid === undefined) return true;
  if (ownerUid === currentUid) return true;
  return policy === "owner-or-root" && ownerUid === ROOT_UID;
}

/**
 * Whether a path's owner is unacceptable, in the shape the call sites use.
 *
 * Reads as the guard it replaces:
 * `if (hasForeignPathOwner(info.uid, policy, process.getuid?.())) throw`.
 *
 * `currentUid` is required rather than defaulted. A default would read the
 * ambient uid on an explicit `undefined`, which is the opposite of what a
 * caller passing `process.getuid?.()` on a platform without uids means, and a
 * security predicate should not have a case where passing "unknown" silently
 * becomes "the real one".
 */
export function hasForeignPathOwner(
  ownerUid: number,
  policy: PathOwnershipPolicy,
  currentUid: number | undefined,
): boolean {
  return !isPermittedPathOwner(ownerUid, policy, currentUid);
}
