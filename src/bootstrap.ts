import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { ensureServiceBearerFile } from "./api-auth.js";
import { ensurePrivateDirectory, validatePrivateFileIfExists } from "./durability.js";

const MAX_AUTH_SEED_BYTES = 1024 * 1024;

export interface ServiceBootstrapOptions {
  stateDir: string;
  socketPath: string;
  agentDir: string;
  apiTokenFile?: string;
  authSeedFile?: string;
  authSeedRequired?: boolean;
}

export interface ServiceBootstrapResult {
  bearerCreated: boolean;
  auth: "existing" | "seeded" | "source_missing" | "not_requested";
}

/**
 * Materializes only daemon-owned private paths. Workload roots remain explicit
 * operator grants and are never created by bootstrap.
 */
export async function bootstrapServicePaths(
  options: ServiceBootstrapOptions,
): Promise<ServiceBootstrapResult> {
  const stateDir = resolve(options.stateDir);
  const socketDirectory = dirname(resolve(options.socketPath));
  const agentDir = resolve(options.agentDir);

  await ensurePrivateDirectory(stateDir, "state directory");
  await ensurePrivateDirectory(socketDirectory, "socket directory");
  await ensurePrivateDirectory(agentDir, "Pi agent directory");

  const [canonicalStateDir, canonicalAgentDir] = await Promise.all([
    realpath(stateDir),
    realpath(agentDir),
  ]);
  if (
    isWithin(canonicalStateDir, canonicalAgentDir) ||
    isWithin(canonicalAgentDir, canonicalStateDir)
  ) {
    throw new Error("Pi agent directory must not overlap daemon state directory");
  }

  const auth = await seedAuthIfAbsent({
    agentDir,
    ...(options.authSeedFile === undefined ? {} : { source: resolve(options.authSeedFile) }),
    required: options.authSeedRequired ?? false,
  });

  let bearerCreated = false;
  if (options.apiTokenFile !== undefined) {
    const tokenFile = resolve(options.apiTokenFile);
    if (!(await pathExists(tokenFile))) {
      await ensurePrivateDirectory(dirname(tokenFile), "API bearer directory");
    }
    bearerCreated = ensureServiceBearerFile(tokenFile);
  }

  return { bearerCreated, auth };
}

interface AuthSeedOptions {
  agentDir: string;
  source?: string;
  required: boolean;
}

async function seedAuthIfAbsent(
  options: AuthSeedOptions,
): Promise<ServiceBootstrapResult["auth"]> {
  const destination = join(options.agentDir, "auth.json");
  if (await pathExists(destination)) {
    await validatePrivateFileIfExists(destination, "Pi auth file");
    return "existing";
  }
  if (options.source === undefined || resolve(options.source) === resolve(destination)) {
    return "not_requested";
  }

  const seed = readPrivateAuthSeed(options.source, options.required);
  if (seed === undefined) return "source_missing";
  const installed = installPrivateFileNoReplace(destination, seed);
  await validatePrivateFileIfExists(destination, "Pi auth file");
  return installed ? "seeded" : "existing";
}

function readPrivateAuthSeed(path: string, required: boolean): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT" && !required) return undefined;
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new Error("Pi auth seed must be a regular non-symlink file");
    }
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error("Pi auth seed must be a regular non-symlink file");
    const getuid = process.getuid;
    if (getuid !== undefined && info.uid !== getuid()) {
      throw new Error("Pi auth seed must be owned by current user");
    }
    if ((info.mode & 0o077) !== 0) throw new Error("Pi auth seed must be owner-only");
    if (info.size === 0 || info.size > MAX_AUTH_SEED_BYTES) {
      throw new Error("Pi auth seed must be between 1 byte and 1 MiB");
    }

    const buffer = Buffer.allocUnsafe(MAX_AUTH_SEED_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (bytes === 0) break;
      offset += bytes;
    }
    if (offset === 0 || offset > MAX_AUTH_SEED_BYTES) {
      throw new Error("Pi auth seed must be between 1 byte and 1 MiB");
    }
    const value = buffer.subarray(0, offset);
    let parsed: unknown;
    try {
      parsed = JSON.parse(value.toString("utf8")) as unknown;
    } catch {
      throw new Error("Pi auth seed must contain valid JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Pi auth seed must contain a JSON object");
    }
    return value;
  } finally {
    closeSync(fd);
  }
}

function installPrivateFileNoReplace(path: string, contents: Buffer): boolean {
  const parent = dirname(path);
  const temporary = join(
    parent,
    `.pi-daemon-bootstrap-${process.pid}-${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  let installed = false;
  try {
    fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temporary, path);
      installed = true;
    } catch (error) {
      if (!(isNodeError(error) && error.code === "EEXIST")) throw error;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
    }
  }
  if (installed) syncDirectory(parent);
  return installed;
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isWithin(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
