import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  atomicWritePrivateJson,
  ensurePrivateDirectory,
  readPrivateJsonIfExists,
} from "./durability.js";
import { PI_DAEMON_VERSION } from "./version.js";

const RELEASE_API = "https://api.github.com/repos/harryaskham/pi-daemon/releases/latest";
const RELEASE_ASSET_PREFIX = "harryaskham-pi-daemon-";
const MAX_RELEASE_METADATA_BYTES = 1024 * 1024;
const MAX_CHECKSUM_BYTES = 4096;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const RELEASE_CHECK_TIMEOUT_MS = 30_000;
const RELEASE_DOWNLOAD_TIMEOUT_MS = 120_000;
const NPM_INSTALL_TIMEOUT_MS = 10 * 60_000;
const INCOMPLETE_LOCK_STALE_MS = 10 * 60_000;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type SelfUpdateAction = "status" | "check" | "run" | "rollback";

export interface SelfUpdatePaths {
  installRoot: string;
  binDir: string;
}

export interface SelfUpdateState {
  schemaVersion: 1;
  activeVersion: string;
  previousVersion?: string;
  installedAt: string;
  packageSha256: string;
}

export interface SelfUpdateRelease {
  version: string;
  tag: string;
  packageAsset: string;
  packageUrl: string;
  checksumAsset: string;
  checksumUrl: string;
  publishedAt?: string;
}

export interface SelfUpdateStatus {
  currentVersion: string;
  activeVersion?: string;
  previousVersion?: string;
  installRoot: string;
  binPath: string;
  managedLink: boolean;
  latest?: SelfUpdateRelease;
  updateAvailable?: boolean;
  localInstallRequired: boolean;
}

export interface SelfUpdateDependencies {
  fetch?: typeof fetch;
  now?: () => Date;
  randomId?: () => string;
  runNpmInstall?: (input: { prefix: string; tarball: string }) => Promise<void>;
}

export class SelfUpdateError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "SelfUpdateError";
  }
}

export class PiDaemonSelfUpdater {
  readonly paths: SelfUpdatePaths;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #randomId: () => string;
  readonly #runNpmInstall: (input: { prefix: string; tarball: string }) => Promise<void>;

  constructor(paths: Partial<SelfUpdatePaths> = {}, dependencies: SelfUpdateDependencies = {}) {
    this.paths = resolveSelfUpdatePaths(paths);
    this.#fetch = dependencies.fetch ?? fetch;
    this.#now = dependencies.now ?? (() => new Date());
    this.#randomId = dependencies.randomId ?? randomUUID;
    this.#runNpmInstall = dependencies.runNpmInstall ?? defaultNpmInstall;
  }

  async status(): Promise<SelfUpdateStatus> {
    const state = await this.#state();
    return {
      currentVersion: PI_DAEMON_VERSION,
      ...(state === undefined ? {} : {
        activeVersion: state.activeVersion,
        ...(state.previousVersion === undefined ? {} : { previousVersion: state.previousVersion }),
      }),
      installRoot: this.paths.installRoot,
      binPath: this.#binPath(),
      managedLink: await this.#isManagedBinLink(),
      localInstallRequired: state === undefined || !(await this.#isManagedBinLink()),
    };
  }

  async check(): Promise<SelfUpdateStatus> {
    const [status, latest] = await Promise.all([this.status(), this.#latestRelease()]);
    const effective = status.activeVersion ?? status.currentVersion;
    return {
      ...status,
      latest,
      updateAvailable: compareVersions(latest.version, effective) > 0,
      localInstallRequired: status.localInstallRequired,
    };
  }

  async run(): Promise<SelfUpdateStatus> {
    await this.#prepareRoots();
    const unlock = await this.#acquireLock();
    try {
      return await this.#runUnlocked();
    } finally {
      await unlock();
    }
  }

  async #runUnlocked(): Promise<SelfUpdateStatus> {
    const checked = await this.check();
    const latest = checked.latest;
    if (latest === undefined) throw new SelfUpdateError("release_unavailable", "latest release is unavailable", true);
    const effective = checked.activeVersion ?? checked.currentVersion;
    const comparison = compareVersions(latest.version, effective);
    if (comparison < 0) {
      throw new SelfUpdateError("update_downgrade_refused", "latest release is older than the active version");
    }
    if (comparison === 0 && !checked.localInstallRequired) return checked;

    const staging = join(this.paths.installRoot, `.staging-${this.#randomId()}`);
    const tarball = join(staging, latest.packageAsset);
    try {
      await mkdir(staging, { mode: 0o700 });
      const [packageBytes, checksumBytes] = await Promise.all([
        this.#download(latest.packageUrl, MAX_PACKAGE_BYTES),
        this.#download(latest.checksumUrl, MAX_CHECKSUM_BYTES),
      ]);
      const expected = parseChecksum(checksumBytes.toString("utf8"), latest.packageAsset);
      const actual = createHash("sha256").update(packageBytes).digest("hex");
      if (actual !== expected) {
        throw new SelfUpdateError("update_checksum_mismatch", "release package checksum did not match");
      }
      await writeFile(tarball, packageBytes, { mode: 0o600 });
      const prefix = join(staging, "install");
      await this.#runNpmInstall({ prefix, tarball });
      const packageRoot = join(prefix, "node_modules", "@harryaskham", "pi-daemon");
      const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
      if (manifest.version !== latest.version) {
        throw new SelfUpdateError("update_artifact_version_mismatch", "release package version did not match its tag");
      }
      await validateInstalledShrinkwrap(packageRoot, latest.version);
      const executable = join(prefix, "node_modules", ".bin", "pi-daemon");
      const executableInfo = await lstat(executable);
      if (!executableInfo.isSymbolicLink() && !executableInfo.isFile()) {
        throw new SelfUpdateError("update_artifact_invalid", "release package did not install pi-daemon");
      }

      const versionDir = this.#versionDir(latest.version);
      await rm(tarball, { force: true });
      if (await pathExists(versionDir)) {
        const existing = await this.#versionMetadata(latest.version);
        if (existing.packageSha256 !== actual) {
          throw new SelfUpdateError("update_release_mutated", "release asset changed for an installed version");
        }
        await rm(prefix, { recursive: true, force: true });
      } else {
        await rename(prefix, versionDir);
        await atomicWritePrivateJson(join(versionDir, ".pi-daemon-update.json"), {
          schemaVersion: 1,
          version: latest.version,
          packageSha256: actual,
        });
      }
      const previous = (await this.#state())?.activeVersion;
      await this.#switchVersion(latest.version);
      await atomicWritePrivateJson(this.#statePath(), {
        schemaVersion: 1,
        activeVersion: latest.version,
        ...(previous === undefined || previous === latest.version ? {} : { previousVersion: previous }),
        installedAt: this.#now().toISOString(),
        packageSha256: actual,
      } satisfies SelfUpdateState);
      await this.#pruneVersions(new Set([latest.version, ...(previous === undefined ? [] : [previous])]));
      return {
        ...(await this.status()),
        latest,
        updateAvailable: false,
        localInstallRequired: false,
      };
    } catch (error) {
      if (error instanceof SelfUpdateError) throw error;
      throw new SelfUpdateError("update_failed", "Pi Daemon update failed", true);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async rollback(): Promise<SelfUpdateStatus> {
    await this.#prepareRoots();
    const unlock = await this.#acquireLock();
    try {
      return await this.#rollbackUnlocked();
    } finally {
      await unlock();
    }
  }

  async #rollbackUnlocked(): Promise<SelfUpdateStatus> {
    const state = await this.#state();
    if (state?.previousVersion === undefined) {
      throw new SelfUpdateError("rollback_unavailable", "no previous managed Pi Daemon version is available");
    }
    const previous = state.previousVersion;
    await this.#validateInstalledVersion(previous);
    await this.#switchVersion(previous);
    const metadata = await this.#versionMetadata(previous);
    await atomicWritePrivateJson(this.#statePath(), {
      schemaVersion: 1,
      activeVersion: previous,
      previousVersion: state.activeVersion,
      installedAt: this.#now().toISOString(),
      packageSha256: metadata.packageSha256,
    } satisfies SelfUpdateState);
    await this.#pruneVersions(new Set([previous, state.activeVersion]));
    return this.status();
  }

  async #latestRelease(): Promise<SelfUpdateRelease> {
    let response: Response;
    try {
      response = await this.#fetch(RELEASE_API, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `pi-daemon/${PI_DAEMON_VERSION}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(RELEASE_CHECK_TIMEOUT_MS),
      });
    } catch {
      throw new SelfUpdateError("release_check_failed", "GitHub release check failed", true);
    }
    if (!response.ok) {
      throw new SelfUpdateError("release_check_failed", "GitHub release check failed", response.status >= 500 || response.status === 429 || response.status === 403);
    }
    const bytes = await readBoundedResponse(response, MAX_RELEASE_METADATA_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new SelfUpdateError("release_metadata_invalid", "GitHub release metadata was invalid");
    }
    return parseRelease(value);
  }

  async #download(url: string, limit: number): Promise<Buffer> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { "User-Agent": `pi-daemon/${PI_DAEMON_VERSION}` },
        redirect: "follow",
        signal: AbortSignal.timeout(RELEASE_DOWNLOAD_TIMEOUT_MS),
      });
    } catch {
      throw new SelfUpdateError("release_download_failed", "release asset download failed", true);
    }
    if (!response.ok) throw new SelfUpdateError("release_download_failed", "release asset download failed", response.status >= 500 || response.status === 429 || response.status === 403);
    return readBoundedResponse(response, limit);
  }

  async #acquireLock(): Promise<() => Promise<void>> {
    const path = join(this.paths.installRoot, "update.lock");
    const ownerPath = join(path, "owner.json");
    const token = this.#randomId();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let acquired = false;
      try {
        await mkdir(path, { mode: 0o700 });
        acquired = true;
        await atomicWritePrivateJson(ownerPath, {
          schemaVersion: 1,
          pid: process.pid,
          token,
          createdAt: this.#now().toISOString(),
        });
        return async () => {
          const owner = await readPrivateJsonIfExists<unknown>(ownerPath).catch(() => undefined);
          if (isRecord(owner) && owner.token === token) {
            await rm(path, { recursive: true, force: true });
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          if (acquired) await rm(path, { recursive: true, force: true });
          throw error;
        }
        const info = await lstat(path).catch(() => undefined);
        if (
          info === undefined ||
          info.isSymbolicLink() ||
          !info.isDirectory() ||
          (process.getuid !== undefined && info.uid !== process.getuid()) ||
          (info.mode & 0o077) !== 0
        ) {
          throw new SelfUpdateError("update_lock_insecure", "self-update lock path is insecure");
        }
        const owner = await readPrivateJsonIfExists<unknown>(ownerPath).catch(() => undefined);
        const ownerPid = isRecord(owner) && Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0
          ? Number(owner.pid)
          : undefined;
        const incompleteIsStale = ownerPid === undefined && this.#now().getTime() - info.mtimeMs > INCOMPLETE_LOCK_STALE_MS;
        if ((ownerPid !== undefined && !processIsAlive(ownerPid)) || incompleteIsStale) {
          await rm(path, { recursive: true, force: true });
          continue;
        }
        throw new SelfUpdateError("update_busy", "another Pi Daemon update is active", true);
      }
    }
    throw new SelfUpdateError("update_busy", "another Pi Daemon update is active", true);
  }

  async #prepareRoots(): Promise<void> {
    await ensurePrivateDirectory(this.paths.installRoot, "self-update install root");
    const versionsRoot = join(this.paths.installRoot, "versions");
    await ensurePrivateDirectory(versionsRoot, "self-update versions root");
    if ((await readdir(versionsRoot)).length > 256) {
      throw new SelfUpdateError("update_retention_exceeded", "managed update version inventory exceeds its bound");
    }
    await ensureOwnedBinDirectory(this.paths.binDir);
    await this.#assertBinLinkAvailable();
  }

  async #switchVersion(version: string): Promise<void> {
    await this.#validateInstalledVersion(version);
    const current = join(this.paths.installRoot, "current");
    await replaceSymlink(this.#versionDir(version), current, this.#randomId());
    await replaceSymlink(
      join(current, "node_modules", ".bin", "pi-daemon"),
      this.#binPath(),
      this.#randomId(),
    );
  }

  async #validateInstalledVersion(version: string): Promise<void> {
    if (!SEMVER.test(version)) throw new SelfUpdateError("update_state_invalid", "managed update version is invalid");
    const root = this.#versionDir(version);
    const [canonicalInstallRoot, canonicalRoot] = await Promise.all([
      realpath(this.paths.installRoot).catch(() => undefined),
      realpath(root).catch(() => undefined),
    ]);
    if (
      canonicalInstallRoot === undefined ||
      canonicalRoot === undefined ||
      !isWithin(canonicalInstallRoot, canonicalRoot)
    ) {
      throw new SelfUpdateError("update_state_invalid", "managed update version is unavailable");
    }
    await this.#versionMetadata(version);
    const executable = join(canonicalRoot, "node_modules", ".bin", "pi-daemon");
    const info = await lstat(executable).catch(() => undefined);
    if (info === undefined || (!info.isFile() && !info.isSymbolicLink())) {
      throw new SelfUpdateError("update_state_invalid", "managed update executable is unavailable");
    }
  }

  async #versionMetadata(version: string): Promise<{ version: string; packageSha256: string }> {
    const value = await readPrivateJsonIfExists<unknown>(join(this.#versionDir(version), ".pi-daemon-update.json"));
    if (
      !isRecord(value) ||
      value.schemaVersion !== 1 ||
      value.version !== version ||
      typeof value.packageSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.packageSha256)
    ) {
      throw new SelfUpdateError("update_state_invalid", "managed update version metadata is invalid");
    }
    return { version, packageSha256: value.packageSha256 };
  }

  async #pruneVersions(keep: ReadonlySet<string>): Promise<void> {
    const root = join(this.paths.installRoot, "versions");
    const entries = await readdir(root, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (keep.has(entry.name)) return;
      await rm(join(root, entry.name), { recursive: true, force: true });
    }));
  }

  async #assertBinLinkAvailable(): Promise<void> {
    const path = this.#binPath();
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined) return;
    if (!info.isSymbolicLink()) {
      throw new SelfUpdateError("update_bin_collision", "local pi-daemon path is not a managed symlink");
    }
    const target = await managedLinkTarget(path);
    if (target === undefined || !isWithin(this.paths.installRoot, target)) {
      throw new SelfUpdateError("update_bin_collision", "local pi-daemon symlink is not managed by Pi Daemon");
    }
  }

  async #isManagedBinLink(): Promise<boolean> {
    const path = this.#binPath();
    const info = await lstat(path).catch(() => undefined);
    if (info?.isSymbolicLink() !== true) return false;
    const target = await managedLinkTarget(path);
    return target !== undefined && isWithin(this.paths.installRoot, target);
  }

  async #state(): Promise<SelfUpdateState | undefined> {
    const value = await readPrivateJsonIfExists<unknown>(this.#statePath());
    if (value === undefined) return undefined;
    if (!isSelfUpdateState(value)) throw new SelfUpdateError("update_state_invalid", "managed update state is invalid");
    return value;
  }

  #statePath(): string {
    return join(this.paths.installRoot, "state.json");
  }

  #versionDir(version: string): string {
    return join(this.paths.installRoot, "versions", version);
  }

  #binPath(): string {
    return join(this.paths.binDir, "pi-daemon");
  }
}

export function resolveSelfUpdatePaths(paths: Partial<SelfUpdatePaths> = {}): SelfUpdatePaths {
  return {
    installRoot: resolve(paths.installRoot ?? join(homedir(), ".local", "share", "pi-daemon")),
    binDir: resolve(paths.binDir ?? join(homedir(), ".local", "bin")),
  };
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = a[index]! - b[index]!;
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

async function defaultNpmInstall(input: { prefix: string; tarball: string }): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const child = spawn("npm", [
      "install",
      "--prefix", input.prefix,
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      input.tarball,
    ], {
      stdio: "ignore",
      shell: false,
    });
    const finish = (error?: SelfUpdateError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolvePromise();
      else reject(error);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new SelfUpdateError("npm_install_timeout", "verified Pi Daemon package installation timed out", true));
    }, NPM_INSTALL_TIMEOUT_MS);
    timer.unref();
    child.once("error", () => finish(new SelfUpdateError("npm_unavailable", "npm is required for Pi Daemon self-update")));
    child.once("exit", (code) => {
      if (code === 0) finish();
      else finish(new SelfUpdateError("npm_install_failed", "verified Pi Daemon package installation failed", true));
    });
  });
}

async function readBoundedResponse(response: Response, limit: number): Promise<Buffer> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    throw new SelfUpdateError("release_asset_too_large", "release response exceeds its byte limit");
  }
  if (response.body === null) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of response.body) {
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > limit) {
      throw new SelfUpdateError("release_asset_too_large", "release response exceeds its byte limit");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function parseRelease(value: unknown): SelfUpdateRelease {
  if (!isRecord(value) || typeof value.tag_name !== "string" || !value.tag_name.startsWith("v")) {
    throw new SelfUpdateError("release_metadata_invalid", "GitHub release metadata was invalid");
  }
  const tag = value.tag_name;
  const version = tag.slice(1);
  if (!SEMVER.test(version) || value.draft === true || value.prerelease === true || !Array.isArray(value.assets)) {
    throw new SelfUpdateError("release_metadata_invalid", "GitHub release metadata was invalid");
  }
  const packageAsset = `${RELEASE_ASSET_PREFIX}${version}.tgz`;
  const checksumAsset = `${packageAsset}.sha256`;
  const packageEntries = value.assets.filter((entry) => isReleaseAsset(entry, packageAsset, tag));
  const checksumEntries = value.assets.filter((entry) => isReleaseAsset(entry, checksumAsset, tag));
  if (packageEntries.length !== 1 || checksumEntries.length !== 1) {
    throw new SelfUpdateError("release_asset_missing", "latest release does not contain one exact self-update artifact pair");
  }
  const packageEntry = packageEntries[0];
  const checksumEntry = checksumEntries[0];
  if (packageEntry === undefined || checksumEntry === undefined) {
    throw new SelfUpdateError("release_asset_missing", "latest release does not contain self-update assets");
  }
  return {
    version,
    tag,
    packageAsset,
    packageUrl: packageEntry.browser_download_url,
    checksumAsset,
    checksumUrl: checksumEntry.browser_download_url,
    ...(typeof value.published_at === "string" ? { publishedAt: value.published_at } : {}),
  };
}

function isReleaseAsset(value: unknown, name: string, tag: string): value is { name: string; browser_download_url: string } {
  const prefix = `https://github.com/harryaskham/pi-daemon/releases/download/${tag}/`;
  return isRecord(value) &&
    value.name === name &&
    typeof value.browser_download_url === "string" &&
    value.browser_download_url === `${prefix}${name}`;
}

async function validateInstalledShrinkwrap(packageRoot: string, version: string): Promise<void> {
  const path = join(packageRoot, "npm-shrinkwrap.json");
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.size > 1024 * 1024) {
    throw new SelfUpdateError("update_shrinkwrap_missing", "release package is missing its bounded npm shrinkwrap");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new SelfUpdateError("update_shrinkwrap_invalid", "release npm shrinkwrap was invalid");
  }
  if (
    !isRecord(value) ||
    value.lockfileVersion !== 3 ||
    !isRecord(value.packages) ||
    !isRecord(value.packages[""]) ||
    value.packages[""].version !== version
  ) {
    throw new SelfUpdateError("update_shrinkwrap_invalid", "release npm shrinkwrap did not match its version");
  }
}

function parseChecksum(value: string, filename: string): string {
  if (value.length > MAX_CHECKSUM_BYTES || value.includes("\0")) {
    throw new SelfUpdateError("release_checksum_invalid", "release checksum was invalid");
  }
  const lines = value.trim().split(/\r?\n/);
  const match = lines.find((line) => line.endsWith(`  ${filename}`));
  const digest = match?.slice(0, 64);
  if (match === undefined || !/^[a-f0-9]{64}$/.test(digest ?? "") || match !== `${digest}  ${filename}`) {
    throw new SelfUpdateError("release_checksum_invalid", "release checksum was invalid");
  }
  return digest!;
}

function parseVersion(value: string): readonly [number, number, number] {
  const match = value.match(SEMVER);
  if (match === null) throw new SelfUpdateError("version_invalid", "Pi Daemon version is not semantic");
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

async function ensureOwnedBinDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o755 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new SelfUpdateError("update_bin_dir_insecure", "local bin path must be a real directory");
  }
  if (process.getuid !== undefined && info.uid !== process.getuid()) {
    throw new SelfUpdateError("update_bin_dir_insecure", "local bin path must be owned by current user");
  }
  if ((info.mode & 0o022) !== 0) {
    throw new SelfUpdateError("update_bin_dir_insecure", "local bin path must not be group/world writable");
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isSelfUpdateState(value: unknown): value is SelfUpdateState {
  return isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.activeVersion === "string" && SEMVER.test(value.activeVersion) &&
    (value.previousVersion === undefined || (typeof value.previousVersion === "string" && SEMVER.test(value.previousVersion))) &&
    typeof value.installedAt === "string" &&
    typeof value.packageSha256 === "string" && /^[a-f0-9]{64}$/.test(value.packageSha256);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function replaceSymlink(target: string, path: string, id: string): Promise<void> {
  const temporary = `${path}.next-${id}`;
  await symlink(target, temporary);
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function managedLinkTarget(path: string): Promise<string | undefined> {
  const target = await readlink(path).catch(() => undefined);
  return target === undefined ? undefined : resolve(dirname(path), target);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
