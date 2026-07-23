import { createHash } from "node:crypto";
import { constants, fstatSync, readSync } from "node:fs";
import { open as openFile, realpath } from "node:fs/promises";
import { createSecureContext } from "node:tls";

export const MAX_DASHBOARD_TLS_MATERIAL_BYTES = 1024 * 1024;
export const MIN_DASHBOARD_TLS_RELOAD_INTERVAL_MS = 1_000;

export interface DashboardTlsSourceConfig {
  certFile?: string;
  certFd?: number;
  keyFile?: string;
  keyFd?: number;
  reloadIntervalMs?: number;
}

export interface DashboardTlsMaterial {
  cert: Buffer;
  key: Buffer;
}

export interface DashboardTlsReloadCandidate extends DashboardTlsMaterial {
  /** Mark this exact candidate active only after the HTTPS server accepts it. */
  commit(): void;
}

export interface DashboardTlsOptions extends DashboardTlsMaterial {
  reloadIntervalMs?: number;
  reload?: () => Promise<DashboardTlsReloadCandidate | undefined>;
}

/**
 * Load one bounded TLS certificate/private-key pair without ever returning its
 * bytes through configuration, status, or error values. File-backed pairs can
 * be polled for atomic certificate rotation; inherited descriptor pairs are
 * consumed once and intentionally cannot be replayed or re-read.
 */
export async function loadDashboardTls(
  config: DashboardTlsSourceConfig | undefined,
): Promise<DashboardTlsOptions | undefined> {
  if (config === undefined) return undefined;
  const certSources = Number(config.certFile !== undefined) + Number(config.certFd !== undefined);
  const keySources = Number(config.keyFile !== undefined) + Number(config.keyFd !== undefined);
  if (certSources === 0 && keySources === 0 && config.reloadIntervalMs === undefined) return undefined;
  if (certSources !== 1 || keySources !== 1) {
    throw new Error("native Dashboard TLS requires exactly one certificate source and one private-key source");
  }
  if (config.certFd !== undefined && config.keyFd !== undefined && config.certFd === config.keyFd) {
    throw new Error("Dashboard TLS certificate and private key must use distinct inherited descriptors");
  }
  if (config.reloadIntervalMs !== undefined) {
    if (
      !Number.isSafeInteger(config.reloadIntervalMs) ||
      config.reloadIntervalMs < MIN_DASHBOARD_TLS_RELOAD_INTERVAL_MS
    ) {
      throw new Error(
        `Dashboard TLS reloadIntervalMs must be at least ${MIN_DASHBOARD_TLS_RELOAD_INTERVAL_MS}`,
      );
    }
    if (config.certFile === undefined || config.keyFile === undefined) {
      throw new Error("Dashboard TLS rotation requires file-backed certificate and private-key sources");
    }
  }

  const loadPair = async (): Promise<DashboardTlsMaterial> => {
    const [cert, key] = await Promise.all([
      config.certFile === undefined
        ? Promise.resolve(readBoundedTlsFd(config.certFd!, false))
        : readBoundedTlsFile(config.certFile, false),
      config.keyFile === undefined
        ? Promise.resolve(readBoundedTlsFd(config.keyFd!, true))
        : readBoundedTlsFile(config.keyFile, true),
    ]);
    validateTlsMaterial(cert, key);
    return { cert, key };
  };

  const initial = await loadPair();
  if (config.reloadIntervalMs === undefined) return initial;
  let digest = tlsMaterialDigest(initial);
  return {
    ...initial,
    reloadIntervalMs: config.reloadIntervalMs,
    reload: async () => {
      const next = await loadPair();
      const nextDigest = tlsMaterialDigest(next);
      if (nextDigest === digest) return undefined;
      return {
        ...next,
        commit: () => {
          digest = nextDigest;
        },
      };
    },
  };
}

async function readBoundedTlsFile(path: string, privateKey: boolean): Promise<Buffer> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    throw new Error(`Dashboard TLS ${privateKey ? "private-key" : "certificate"} file is unavailable`);
  }
  let handle;
  try {
    handle = await openFile(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error(
      `Dashboard TLS ${privateKey ? "private-key" : "certificate"} file must resolve to a regular file`,
    );
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error(
        `Dashboard TLS ${privateKey ? "private-key" : "certificate"} file must be regular`,
      );
    }
    const getuid = process.getuid;
    if (getuid !== undefined && info.uid !== getuid() && info.uid !== 0) {
      throw new Error(
        `Dashboard TLS ${privateKey ? "private-key" : "certificate"} file must be owner-controlled`,
      );
    }
    if ((info.mode & (privateKey ? 0o077 : 0o022)) !== 0) {
      throw new Error(
        privateKey
          ? "Dashboard TLS private-key file must be owner-only"
          : "Dashboard TLS certificate file must not be group/world writable",
      );
    }
    if (info.size <= 0 || info.size > MAX_DASHBOARD_TLS_MATERIAL_BYTES) {
      throw new Error(`Dashboard TLS ${privateKey ? "private key" : "certificate"} exceeds its byte bound`);
    }
    const value = await handle.readFile();
    if (value.length === 0 || value.length > MAX_DASHBOARD_TLS_MATERIAL_BYTES) {
      throw new Error(`Dashboard TLS ${privateKey ? "private key" : "certificate"} exceeds its byte bound`);
    }
    return value;
  } finally {
    await handle.close();
  }
}

function readBoundedTlsFd(fd: number, privateKey: boolean): Buffer {
  if (!Number.isSafeInteger(fd) || fd < 3) {
    throw new Error(
      `Dashboard TLS ${privateKey ? "private-key" : "certificate"} descriptor must be an inherited descriptor of at least 3`,
    );
  }
  const info = fstatSync(fd);
  if (info.isDirectory()) {
    throw new Error(`Dashboard TLS ${privateKey ? "private-key" : "certificate"} descriptor is invalid`);
  }
  if (info.isFile() && (info.size <= 0 || info.size > MAX_DASHBOARD_TLS_MATERIAL_BYTES)) {
    throw new Error(`Dashboard TLS ${privateKey ? "private key" : "certificate"} exceeds its byte bound`);
  }
  const value = Buffer.allocUnsafe(MAX_DASHBOARD_TLS_MATERIAL_BYTES + 1);
  let offset = 0;
  while (offset < value.length) {
    const bytes = readSync(fd, value, offset, value.length - offset, null);
    if (bytes === 0) break;
    offset += bytes;
  }
  if (offset === 0 || offset > MAX_DASHBOARD_TLS_MATERIAL_BYTES) {
    throw new Error(`Dashboard TLS ${privateKey ? "private key" : "certificate"} exceeds its byte bound`);
  }
  return Buffer.from(value.subarray(0, offset));
}

function validateTlsMaterial(cert: Buffer, key: Buffer): void {
  try {
    createSecureContext({ cert, key, minVersion: "TLSv1.2" });
  } catch {
    throw new Error("Dashboard TLS certificate/private-key material is invalid or mismatched");
  }
}

function tlsMaterialDigest(material: DashboardTlsMaterial): string {
  return createHash("sha256")
    .update(material.cert)
    .update("\0", "utf8")
    .update(material.key)
    .digest("base64url");
}
