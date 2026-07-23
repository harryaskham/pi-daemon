import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  DashboardBrowserSessionResource,
  DashboardLoginRequest,
} from "./dashboard-contract.js";
import {
  localOwnerIdentityProvider,
  type DashboardIdentityProvider,
  type DashboardPrincipal,
} from "./dashboard-identity.js";

export const DASH_BROWSER_COOKIE = "pi-daemon-dash" as const;
export const DASH_BROWSER_SECURE_COOKIE = "__Host-pi-daemon-dash" as const;
export const DASH_CSRF_HEADER = "x-pi-daemon-csrf" as const;
export const MIN_DASH_CREDENTIAL_BYTES = 16;
export const MAX_DASH_CREDENTIAL_BYTES = 4096;
const MAX_RAW_CREDENTIAL_BYTES = MAX_DASH_CREDENTIAL_BYTES + 2;
const MAX_COOKIE_HEADER_BYTES = 8192;
const MAX_BROWSER_SESSIONS = 256;
export const MAX_DASH_BROWSER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class DashboardAuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 401) {
    super(message);
    this.name = "DashboardAuthError";
    this.code = code;
    this.status = status;
  }
}

export interface DashboardBrowserAuthOptions {
  /** Existing one-operator compatibility input; mutually exclusive with identityProvider. */
  credential?: string;
  /** Startup-loaded provider; credentials and provider internals never enter browser session state. */
  identityProvider?: DashboardIdentityProvider;
  sessionTtlMs: number;
  secureCookies?: boolean;
  maxSessions?: number;
  now?: () => Date;
  signingKey?: Uint8Array;
  randomBytes?: (size: number) => Uint8Array;
}

export interface DashboardAuthenticatedSession {
  readonly sessionKey: string;
  readonly principal: DashboardPrincipal;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly expiresAt: string;
}

interface BrowserSessionRecord {
  sessionKey: string;
  principal: DashboardPrincipal;
  clientId: string;
  workspaceId: string;
  csrfDigest: Buffer;
  expiresAtMs: number;
}

export interface DashboardLoginResult {
  session: DashboardBrowserSessionResource;
  setCookie: string;
}

/**
 * Provider-authenticated identity exchanged for bounded, revocable browser
 * sessions. The compatibility credential and issued CSRF values are retained
 * only as one-way digests. Cookie payloads carry a random lookup key plus an
 * HMAC; principal and authorization state remain server-side.
 */
export class DashboardBrowserAuth {
  readonly sessionTtlMs: number;
  readonly secureCookies: boolean;
  readonly maxSessions: number;
  readonly #identityProvider: DashboardIdentityProvider;
  readonly #signingKey: Buffer;
  readonly #now: () => Date;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #sessions = new Map<string, BrowserSessionRecord>();

  constructor(options: DashboardBrowserAuthOptions) {
    this.sessionTtlMs = positiveInteger(options.sessionTtlMs, "sessionTtlMs");
    if (this.sessionTtlMs > MAX_DASH_BROWSER_SESSION_TTL_MS) {
      throw new RangeError("sessionTtlMs exceeds the seven-day browser-session limit");
    }
    this.secureCookies = options.secureCookies ?? false;
    this.maxSessions = positiveInteger(options.maxSessions ?? MAX_BROWSER_SESSIONS, "maxSessions");
    if ((options.credential === undefined) === (options.identityProvider === undefined)) {
      throw new Error("configure exactly one dashboard credential or identity provider");
    }
    this.#identityProvider =
      options.identityProvider ?? localOwnerIdentityProvider(validateCredential(options.credential!));
    this.#signingKey = Buffer.from(options.signingKey ?? randomBytes(32));
    if (this.#signingKey.length !== 32) throw new Error("dashboard signing key must be 32 bytes");
    this.#now = options.now ?? (() => new Date());
    this.#randomBytes = options.randomBytes ?? randomBytes;
  }

  static async fromTokenFile(
    path: string,
    options: Omit<DashboardBrowserAuthOptions, "credential" | "identityProvider">,
  ): Promise<DashboardBrowserAuth> {
    return new DashboardBrowserAuth({
      ...options,
      credential: await readPrivateDashboardCredential(path),
    });
  }

  login(request: DashboardLoginRequest): DashboardLoginResult {
    validateLoginRequest(request);
    const principal = this.#identityProvider.authenticate(request.credential);
    if (principal === undefined) {
      throw new DashboardAuthError("login_failed", "dashboard login failed");
    }

    const now = this.#now().getTime();
    this.#prune(now);
    if (this.#sessions.size >= this.maxSessions) {
      throw new DashboardAuthError(
        "browser_session_capacity",
        "dashboard browser session capacity is exhausted",
        503,
      );
    }

    const sessionKey = token(this.#randomBytes(32));
    const csrfToken = this.#csrfToken(sessionKey);
    const workspaceId = request.workspaceId ?? `workspace-${token(this.#randomBytes(18))}`;
    validateOpaqueId(workspaceId, "workspaceId");
    const expiresAtMs = now + this.sessionTtlMs;
    this.#sessions.set(sessionKey, {
      sessionKey,
      principal,
      clientId: request.clientId,
      workspaceId,
      csrfDigest: digest(csrfToken),
      expiresAtMs,
    });

    const cookieValue = this.#signedCookie(sessionKey);
    return {
      session: {
        clientId: request.clientId,
        workspaceId,
        expiresAt: new Date(expiresAtMs).toISOString(),
        csrfToken,
      },
      setCookie: this.#serializeCookie(cookieValue, this.sessionTtlMs),
    };
  }

  authenticate(cookieHeader: string | string[] | undefined): DashboardAuthenticatedSession {
    const cookieValue = parseCookie(cookieHeader, this.cookieName);
    if (cookieValue === undefined) {
      throw new DashboardAuthError("unauthorized", "dashboard browser session is required");
    }
    const sessionKey = this.#verifyCookie(cookieValue);
    if (sessionKey === undefined) {
      throw new DashboardAuthError("unauthorized", "dashboard browser session is invalid");
    }
    const record = this.#activeRecord(sessionKey, this.#now().getTime());
    if (record === undefined) {
      throw new DashboardAuthError("unauthorized", "dashboard browser session is invalid");
    }
    return {
      sessionKey: record.sessionKey,
      principal: structuredClone(record.principal),
      clientId: record.clientId,
      workspaceId: record.workspaceId,
      expiresAt: new Date(record.expiresAtMs).toISOString(),
    };
  }

  revalidate(session: DashboardAuthenticatedSession): DashboardAuthenticatedSession {
    const record = this.#activeRecord(session.sessionKey, this.#now().getTime());
    if (record === undefined) {
      throw new DashboardAuthError("unauthorized", "dashboard browser session is invalid");
    }
    return {
      sessionKey: record.sessionKey,
      principal: structuredClone(record.principal),
      clientId: record.clientId,
      workspaceId: record.workspaceId,
      expiresAt: new Date(record.expiresAtMs).toISOString(),
    };
  }

  browserSession(session: DashboardAuthenticatedSession): DashboardBrowserSessionResource {
    const record = this.revalidate(session);
    return {
      clientId: record.clientId,
      workspaceId: record.workspaceId,
      expiresAt: record.expiresAt,
      csrfToken: this.#csrfToken(record.sessionKey),
    };
  }

  authorizeCsrf(session: DashboardAuthenticatedSession, value: string | string[] | undefined): void {
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 256) {
      throw new DashboardAuthError("csrf_failed", "dashboard CSRF validation failed", 403);
    }
    const record = this.#sessions.get(session.sessionKey);
    if (record === undefined || !timingSafeEqual(record.csrfDigest, digest(value))) {
      throw new DashboardAuthError("csrf_failed", "dashboard CSRF validation failed", 403);
    }
  }

  revoke(session: DashboardAuthenticatedSession): string {
    this.#sessions.delete(session.sessionKey);
    return this.#serializeCookie("", 0);
  }

  revokeAll(): void {
    this.#sessions.clear();
  }

  revokeIdentity(identityId: string): number {
    let revoked = 0;
    for (const [key, session] of this.#sessions) {
      if (session.principal.identityId !== identityId) continue;
      this.#sessions.delete(key);
      revoked += 1;
    }
    return revoked;
  }

  get activeSessions(): number {
    this.#prune(this.#now().getTime());
    return this.#sessions.size;
  }

  get cookieName(): string {
    return this.secureCookies ? DASH_BROWSER_SECURE_COOKIE : DASH_BROWSER_COOKIE;
  }

  #csrfToken(sessionKey: string): string {
    return createHmac("sha256", this.#signingKey)
      .update("csrf-v1\0", "utf8")
      .update(sessionKey, "utf8")
      .digest("base64url");
  }

  #signedCookie(sessionKey: string): string {
    const signature = createHmac("sha256", this.#signingKey).update(sessionKey, "utf8").digest("base64url");
    return `v1.${sessionKey}.${signature}`;
  }

  #verifyCookie(value: string): string | undefined {
    if (value.length > 256) return undefined;
    const match = /^v1\.([A-Za-z0-9_-]{40,64})\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (match === null) return undefined;
    const sessionKey = match[1]!;
    const expected = this.#signedCookie(sessionKey);
    const left = Buffer.from(value, "utf8");
    const right = Buffer.from(expected, "utf8");
    return left.length === right.length && timingSafeEqual(left, right) ? sessionKey : undefined;
  }

  #serializeCookie(value: string, ttlMs: number): string {
    const maxAge = Math.max(0, Math.floor(ttlMs / 1000));
    return [
      `${this.cookieName}=${value}`,
      "Path=/dash/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${maxAge}`,
      ...(this.secureCookies ? ["Secure"] : []),
    ].join("; ");
  }

  #activeRecord(sessionKey: string, now: number): BrowserSessionRecord | undefined {
    const record = this.#sessions.get(sessionKey);
    if (record === undefined || record.expiresAtMs <= now) {
      if (record !== undefined) this.#sessions.delete(sessionKey);
      return undefined;
    }
    const current = this.#identityProvider.principal(record.principal.identityId);
    if (current === undefined || !samePrincipal(current, record.principal)) {
      this.#sessions.delete(sessionKey);
      return undefined;
    }
    return record;
  }

  #prune(now: number): void {
    for (const key of this.#sessions.keys()) this.#activeRecord(key, now);
  }
}

export async function ensureDashboardCredentialFile(path: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(dirname(path));
  const getuid = process.getuid;
  if (
    !directoryInfo.isDirectory() ||
    directoryInfo.isSymbolicLink() ||
    (getuid !== undefined && directoryInfo.uid !== getuid()) ||
    (directoryInfo.mode & 0o077) !== 0
  ) {
    throw new Error("dashboard credential directory must be an owner-only real directory");
  }
  try {
    await readPrivateDashboardCredential(path);
    return false;
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
  }

  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${randomBytes(32).toString("base64url")}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  let created = false;
  try {
    await link(temporary, path);
    created = true;
  } catch (error) {
    if (!(isNodeError(error) && error.code === "EEXIST")) throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  const directory = await open(dirname(path), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  await readPrivateDashboardCredential(path);
  return created;
}

export async function readPrivateDashboardCredential(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new Error("dashboard credential file must be a regular non-symlink file");
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("dashboard credential file must be a regular file");
    const getuid = process.getuid;
    if (getuid !== undefined && info.uid !== getuid()) {
      throw new Error("dashboard credential file must be owned by the current user");
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error("dashboard credential file must be owner-only");
    }
    if (info.size > MAX_RAW_CREDENTIAL_BYTES) {
      throw new Error("dashboard credential file exceeds its byte limit");
    }
    const buffer = Buffer.allocUnsafe(MAX_RAW_CREDENTIAL_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_RAW_CREDENTIAL_BYTES) {
      throw new Error("dashboard credential file exceeds its byte limit");
    }
    return validateCredential(stripOneLineEnding(buffer.subarray(0, offset).toString("utf8")));
  } finally {
    await handle.close();
  }
}

function validateLoginRequest(request: DashboardLoginRequest): void {
  if (!isRecord(request) || typeof request.credential !== "string") {
    throw new DashboardAuthError("login_failed", "dashboard login failed");
  }
  const allowed = new Set(["requestId", "clientId", "workspaceId", "credential"]);
  if (
    Object.keys(request).some((key) => !allowed.has(key)) ||
    !Object.prototype.hasOwnProperty.call(request, "requestId") ||
    !Object.prototype.hasOwnProperty.call(request, "clientId") ||
    !Object.prototype.hasOwnProperty.call(request, "credential")
  ) {
    throw new DashboardAuthError("login_failed", "dashboard login failed");
  }
  validateOpaqueId(request.requestId, "requestId");
  validateOpaqueId(request.clientId, "clientId");
  if (request.workspaceId !== undefined) validateOpaqueId(request.workspaceId, "workspaceId");
}

function validateOpaqueId(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new DashboardAuthError("invalid_request", `${name} is invalid`, 400);
  }
}

function parseCookie(
  header: string | string[] | undefined,
  name: string,
): string | undefined {
  if (typeof header !== "string" || Buffer.byteLength(header, "utf8") > MAX_COOKIE_HEADER_BYTES) {
    return undefined;
  }
  let found: string | undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    if (found !== undefined) return undefined;
    found = part.slice(index + 1).trim();
  }
  return found;
}

function validateCredential(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < MIN_DASH_CREDENTIAL_BYTES || bytes > MAX_DASH_CREDENTIAL_BYTES) {
    throw new Error("dashboard credential must satisfy its byte bounds");
  }
  if (/\r|\n|\0/.test(value)) throw new Error("dashboard credential contains invalid characters");
  return value;
}

function stripOneLineEnding(value: string): string {
  return value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function samePrincipal(left: DashboardPrincipal, right: DashboardPrincipal): boolean {
  return (
    left.identityId === right.identityId &&
    left.globalRole === right.globalRole &&
    left.displayName === right.displayName
  );
}

function token(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
