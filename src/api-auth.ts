import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

export const SERVICE_BEARER_ENV = "PI_DAEMON_BEARER_TOKEN";
export const MIN_SERVICE_BEARER_BYTES = 16;
export const MAX_SERVICE_BEARER_BYTES = 4096;

export interface ServiceBearerSourceOptions {
  tokenFile?: string;
  tokenFd?: number;
  environment?: NodeJS.ProcessEnv;
}

export type ServiceBearerSource = "file" | "fd" | "environment";

export interface LoadedServiceBearer {
  authenticator: ServiceBearerAuthenticator;
  source: ServiceBearerSource;
}

/** Holds only a one-way digest of the configured bearer. */
export class ServiceBearerAuthenticator {
  readonly #digest: Buffer;

  constructor(token: string) {
    this.#digest = digestToken(validateBearer(token));
  }

  authenticate(authorization: string | string[] | undefined): boolean {
    if (typeof authorization !== "string") return false;
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    if (match === null) return false;
    const candidate = match[1]!;
    if (
      Buffer.byteLength(candidate, "utf8") < MIN_SERVICE_BEARER_BYTES ||
      Buffer.byteLength(candidate, "utf8") > MAX_SERVICE_BEARER_BYTES
    ) {
      return false;
    }
    return timingSafeEqual(this.#digest, digestToken(candidate));
  }
}

export function loadServiceBearer(
  options: ServiceBearerSourceOptions = {},
): LoadedServiceBearer {
  const environment = options.environment ?? process.env;
  const environmentToken = environment[SERVICE_BEARER_ENV];
  const sources = [
    options.tokenFile === undefined ? undefined : "file",
    options.tokenFd === undefined ? undefined : "fd",
    environmentToken === undefined ? undefined : "environment",
  ].filter((source): source is ServiceBearerSource => source !== undefined);
  if (sources.length !== 1) {
    throw new Error(
      sources.length === 0
        ? `API listener requires exactly one bearer source: --api-token-file, --api-token-fd, or ${SERVICE_BEARER_ENV}`
        : "API listener bearer sources are mutually exclusive",
    );
  }

  const source = sources[0]!;
  let token: string;
  switch (source) {
    case "file":
      token = readPrivateTokenFile(options.tokenFile!);
      break;
    case "fd": {
      const fd = options.tokenFd!;
      if (!Number.isSafeInteger(fd) || fd < 3) {
        throw new Error("--api-token-fd must be an inherited file descriptor of at least 3");
      }
      token = readFileSync(fd, "utf8");
      break;
    }
    case "environment":
      token = environmentToken!;
      break;
  }
  return { source, authenticator: new ServiceBearerAuthenticator(stripOneLineEnding(token)) };
}

function readPrivateTokenFile(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new Error("API bearer token file must be a regular non-symlink file");
    }
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) {
      throw new Error("API bearer token file must be a regular non-symlink file");
    }
    const getuid = process.getuid;
    if (getuid !== undefined && info.uid !== getuid()) {
      throw new Error("API bearer token file must be owned by the current user");
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error("API bearer token file must be owner-only");
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function stripOneLineEnding(value: string): string {
  return value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;
}

function validateBearer(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < MIN_SERVICE_BEARER_BYTES || bytes > MAX_SERVICE_BEARER_BYTES) {
    throw new Error(
      `API bearer token must be between ${MIN_SERVICE_BEARER_BYTES} and ${MAX_SERVICE_BEARER_BYTES} UTF-8 bytes`,
    );
  }
  if (!/^[A-Za-z0-9\-._~+/]+=*$/.test(value)) {
    throw new Error("API bearer token contains characters that are unsafe in an HTTP Bearer header");
  }
  return value;
}

function digestToken(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
