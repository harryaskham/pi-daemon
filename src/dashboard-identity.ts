import { createHash, timingSafeEqual } from "node:crypto";

export const DASHBOARD_LOCAL_OWNER_ID = "local-owner" as const;
export const MAX_DASHBOARD_IDENTITIES = 128;
export const MAX_DASHBOARD_IDENTITY_ID_BYTES = 128;
export const MAX_DASHBOARD_DISPLAY_NAME_BYTES = 256;
export const MIN_DASHBOARD_IDENTITY_CREDENTIAL_BYTES = 16;
export const MAX_DASHBOARD_IDENTITY_CREDENTIAL_BYTES = 4096;

export type DashboardGlobalRole = "administrator" | "member";

export interface DashboardPrincipal {
  readonly identityId: string;
  readonly globalRole: DashboardGlobalRole;
  readonly displayName?: string;
}

export interface DashboardIdentityProvider {
  /**
   * Resolve one input-only high-entropy credential to a principal. Providers
   * return no reason on failure so callers cannot distinguish identity absence,
   * revocation, or a wrong credential.
   */
  authenticate(credential: string): DashboardPrincipal | undefined;
  /** Revalidate an existing server-side principal without accepting browser identity input. */
  principal(identityId: string): DashboardPrincipal | undefined;
}

export interface StaticDashboardIdentity {
  identityId: string;
  globalRole: DashboardGlobalRole;
  displayName?: string;
  credential: string;
}

interface StaticIdentityRecord {
  principal: DashboardPrincipal;
  credentialDigest: Buffer;
}

/**
 * Bounded startup-loaded token provider. Only SHA-256 digests are retained and
 * every authentication attempt compares against every configured identity.
 * Tokens must be independently generated high-entropy values; this is not a
 * password hashing API.
 */
export class StaticDashboardIdentityProvider implements DashboardIdentityProvider {
  readonly #records: readonly StaticIdentityRecord[];

  constructor(identities: readonly StaticDashboardIdentity[]) {
    if (identities.length < 1 || identities.length > MAX_DASHBOARD_IDENTITIES) {
      throw new Error(`dashboard identities must contain between 1 and ${MAX_DASHBOARD_IDENTITIES} entries`);
    }
    const identityIds = new Set<string>();
    const credentialDigests: Buffer[] = [];
    const records: StaticIdentityRecord[] = [];
    for (const identity of identities) {
      const principal = validateDashboardPrincipal(identity);
      if (identityIds.has(principal.identityId)) {
        throw new Error("dashboard identity IDs must be unique");
      }
      identityIds.add(principal.identityId);
      const credentialDigest = digestCredential(validateIdentityCredential(identity.credential));
      if (credentialDigests.some((candidate) => timingSafeEqual(candidate, credentialDigest))) {
        throw new Error("dashboard identity credentials must be unique");
      }
      credentialDigests.push(credentialDigest);
      records.push({ principal, credentialDigest });
    }
    if (!records.some(({ principal }) => principal.globalRole === "administrator")) {
      throw new Error("dashboard identities require at least one administrator");
    }
    this.#records = Object.freeze(records);
  }

  authenticate(credential: string): DashboardPrincipal | undefined {
    const bytes = typeof credential === "string" ? Buffer.byteLength(credential, "utf8") : 0;
    const valid =
      typeof credential === "string" &&
      bytes >= MIN_DASHBOARD_IDENTITY_CREDENTIAL_BYTES &&
      bytes <= MAX_DASHBOARD_IDENTITY_CREDENTIAL_BYTES &&
      !/[\r\n\0]/.test(credential);
    const candidate = digestCredential(valid ? credential : "invalid-dashboard-credential");
    let matched: DashboardPrincipal | undefined;
    for (const record of this.#records) {
      if (timingSafeEqual(record.credentialDigest, candidate)) matched = record.principal;
    }
    return matched === undefined ? undefined : structuredClone(matched);
  }

  principal(identityId: string): DashboardPrincipal | undefined {
    const record = this.#records.find(
      ({ principal }) => principal.identityId === identityId,
    );
    return record === undefined ? undefined : structuredClone(record.principal);
  }
}

export function localOwnerIdentityProvider(credential: string): DashboardIdentityProvider {
  return new StaticDashboardIdentityProvider([
    {
      identityId: DASHBOARD_LOCAL_OWNER_ID,
      globalRole: "administrator",
      displayName: "Local owner",
      credential,
    },
  ]);
}

export function validateDashboardPrincipal(value: {
  identityId: unknown;
  globalRole: unknown;
  displayName?: unknown;
}): DashboardPrincipal {
  const identityId = validateDashboardIdentityId(value.identityId);
  if (value.globalRole !== "administrator" && value.globalRole !== "member") {
    throw new Error("dashboard global role is invalid");
  }
  if (value.displayName === undefined) {
    return { identityId, globalRole: value.globalRole };
  }
  if (
    typeof value.displayName !== "string" ||
    value.displayName.length < 1 ||
    Buffer.byteLength(value.displayName, "utf8") > MAX_DASHBOARD_DISPLAY_NAME_BYTES ||
    /[\r\n\0]/.test(value.displayName)
  ) {
    throw new Error("dashboard identity display name is invalid");
  }
  return { identityId, globalRole: value.globalRole, displayName: value.displayName };
}

export function validateDashboardIdentityId(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_DASHBOARD_IDENTITY_ID_BYTES ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  ) {
    throw new Error("dashboard identity ID is invalid");
  }
  return value;
}

function validateIdentityCredential(value: unknown): string {
  if (typeof value !== "string") throw new Error("dashboard identity credential is invalid");
  const bytes = Buffer.byteLength(value, "utf8");
  if (
    bytes < MIN_DASHBOARD_IDENTITY_CREDENTIAL_BYTES ||
    bytes > MAX_DASHBOARD_IDENTITY_CREDENTIAL_BYTES ||
    /[\r\n\0]/.test(value)
  ) {
    throw new Error("dashboard identity credential is invalid");
  }
  return value;
}

function digestCredential(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
