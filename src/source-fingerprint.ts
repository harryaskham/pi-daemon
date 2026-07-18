import {
  asDashboardFingerprint,
  type DashboardFingerprint,
} from "./dashboard-contract.js";

/** Canonical content-fingerprint encoding shared by inventory and transcript projection. */
export function formatSessionSourceFingerprint(digest: Uint8Array): DashboardFingerprint {
  if (digest.byteLength !== 32) {
    throw new RangeError("SHA-256 session source digest must contain exactly 32 bytes");
  }
  return asDashboardFingerprint(`sha256:${Buffer.from(digest).toString("base64url")}`);
}
