import { closeSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { parseDocument } from "yaml";

import {
  PiDaemonConfigError,
  parseDashboardIdentityProviderConfig,
  type PiDaemonWebIdentityProviderConfig,
} from "./config.js";
import {
  readPrivateDashboardCredential,
  readPrivateDashboardCredentialFd,
} from "./dashboard-auth.js";
import {
  StaticDashboardIdentityProvider,
  type DashboardIdentityProvider,
  type StaticDashboardIdentity,
} from "./dashboard-identity.js";

export const MAX_DASHBOARD_IDENTITY_PROVIDER_FILE_BYTES = 256 * 1024;

/**
 * Load a strict non-secret YAML/JSON provider document. The document may contain
 * identity metadata and credential file paths/inherited descriptor numbers, but
 * never credential bytes.
 */
export async function loadDashboardIdentityProviderFile(path: string): Promise<DashboardIdentityProvider> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new PiDaemonConfigError(
      "identity_provider_unreadable",
      "dashboard identity provider file could not be inspected",
    );
  }
  if (!info.isFile()) {
    throw new PiDaemonConfigError(
      "identity_provider_not_regular",
      "dashboard identity provider path must resolve to a regular file",
    );
  }
  const getuid = process.getuid;
  if (getuid !== undefined && info.uid !== getuid() && info.uid !== 0) {
    throw new PiDaemonConfigError(
      "identity_provider_owner_mismatch",
      "dashboard identity provider file must be owned by the current user or root",
    );
  }
  if ((info.mode & 0o022) !== 0) {
    throw new PiDaemonConfigError(
      "identity_provider_insecure_mode",
      "dashboard identity provider file must not be group/world writable",
    );
  }
  if (info.size > MAX_DASHBOARD_IDENTITY_PROVIDER_FILE_BYTES) {
    throw new PiDaemonConfigError(
      "identity_provider_too_large",
      "dashboard identity provider file exceeds its byte limit",
    );
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new PiDaemonConfigError(
      "identity_provider_unreadable",
      "dashboard identity provider file could not be read",
    );
  }
  if (Buffer.byteLength(text, "utf8") > MAX_DASHBOARD_IDENTITY_PROVIDER_FILE_BYTES) {
    throw new PiDaemonConfigError(
      "identity_provider_too_large",
      "dashboard identity provider file exceeds its byte limit",
    );
  }
  const document = parseDocument(text, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new PiDaemonConfigError(
      "identity_provider_invalid_yaml",
      "dashboard identity provider file is not valid YAML",
    );
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new PiDaemonConfigError(
      "identity_provider_invalid_yaml",
      "dashboard identity provider aliases are not allowed",
    );
  }
  const config = parseDashboardIdentityProviderConfig(value ?? {});
  return createDashboardIdentityProvider(config, (credentialPath) =>
    expandProviderPath(credentialPath, dirname(path))
  );
}

/** Construct a provider from inline daemon YAML after resolving only source paths. */
export async function createDashboardIdentityProvider(
  config: PiDaemonWebIdentityProviderConfig,
  resolvePath: (path: string) => string,
): Promise<DashboardIdentityProvider> {
  const identities: StaticDashboardIdentity[] = [];
  for (const identity of config.identities) {
    let credential: string;
    if (identity.credentialFile !== undefined) {
      credential = await readPrivateDashboardCredential(resolvePath(identity.credentialFile));
    } else {
      try {
        credential = readPrivateDashboardCredentialFd(identity.credentialFd!);
      } finally {
        closeSync(identity.credentialFd!);
      }
    }
    identities.push({
      identityId: identity.identityId,
      globalRole: identity.globalRole,
      ...(identity.displayName === undefined ? {} : { displayName: identity.displayName }),
      credential,
    });
  }
  return new StaticDashboardIdentityProvider(identities);
}

function expandProviderPath(value: string, baseDirectory: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(baseDirectory, value);
}
