import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import {
  DefaultPackageManager,
  SettingsManager,
  type PackageSource,
  type ResolvedPaths,
} from "@earendil-works/pi-coding-agent";

export const MAX_INSTALLED_PACKAGE_SETTINGS_BYTES = 1024 * 1024;
export const MAX_INSTALLED_PI_PACKAGES = 128;
export const MAX_INSTALLED_PACKAGE_FILTERS = 256;
export const MAX_INSTALLED_PACKAGE_RESOURCES_PER_TYPE = 512;
export const MAX_INSTALLED_PACKAGE_PATH_BYTES = 4096;

export interface InstalledPiPackageResources {
  extensions: string[];
  skills: string[];
  promptTemplates: string[];
  themes: string[];
}

export class InstalledPiPackageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "InstalledPiPackageError";
  }
}

/**
 * Resolve package resources already installed by the Pi CLI.
 *
 * This path is intentionally read-only: every configured source is checked for
 * an existing install before SDK resolution, and the SDK missing-source callback
 * always returns `error`. It never installs, updates, reconciles, or invokes a
 * package-manager command.
 */
export async function resolveInstalledPiPackageResources(options: {
  cwd: string;
  agentDir: string;
}): Promise<InstalledPiPackageResources> {
  const settingsPath = join(options.agentDir, "settings.json");
  const packages = await readGlobalPackageDeclarations(settingsPath);
  if (packages.length === 0) return emptyInstalledPiPackageResources();

  const locatorSettings = SettingsManager.inMemory({ packages }, { projectTrusted: false });
  const locator = new DefaultPackageManager({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: locatorSettings,
  });
  const installedPackages = await installedLocalPackageSources(
    packages,
    locator,
    options.agentDir,
  );
  // Resolve absolute local paths only. Converting npm/git declarations after
  // proving their managed installs exist makes package-manager subprocess and
  // network authority structurally unreachable, including disappearance races.
  const resolverSettings = SettingsManager.inMemory(
    { packages: installedPackages },
    { projectTrusted: false },
  );
  const resolver = new DefaultPackageManager({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: resolverSettings,
  });

  let resolved: ResolvedPaths;
  try {
    resolved = await resolver.resolve(async () => "error");
    await assertNormalizedPackageSourcesRemain(installedPackages);
  } catch {
    throw unavailable();
  }
  return {
    extensions: enabledPackagePaths(resolved.extensions),
    skills: enabledPackagePaths(resolved.skills),
    promptTemplates: enabledPackagePaths(resolved.prompts),
    themes: enabledPackagePaths(resolved.themes),
  };
}

export function emptyInstalledPiPackageResources(): InstalledPiPackageResources {
  return { extensions: [], skills: [], promptTemplates: [], themes: [] };
}

async function readGlobalPackageDeclarations(path: string): Promise<PackageSource[]> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new InstalledPiPackageError(
      "installed_package_settings_unavailable",
      "installed Pi package settings are unavailable",
    );
  }
  const getuid = process.getuid;
  if (
    !info.isFile() ||
    info.size > MAX_INSTALLED_PACKAGE_SETTINGS_BYTES ||
    (getuid !== undefined && info.uid !== getuid() && info.uid !== 0) ||
    (info.mode & 0o022) !== 0
  ) {
    throw new InstalledPiPackageError(
      "installed_package_settings_invalid",
      "installed Pi package settings are invalid",
    );
  }
  let value: unknown;
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_INSTALLED_PACKAGE_SETTINGS_BYTES) throw new Error();
    value = JSON.parse(text) as unknown;
  } catch {
    throw new InstalledPiPackageError(
      "installed_package_settings_invalid",
      "installed Pi package settings are invalid",
    );
  }
  if (!isRecord(value)) {
    throw new InstalledPiPackageError(
      "installed_package_settings_invalid",
      "installed Pi package settings are invalid",
    );
  }
  const raw = value.packages;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_INSTALLED_PI_PACKAGES) {
    throw new InstalledPiPackageError(
      "installed_package_settings_invalid",
      "installed Pi package settings are invalid",
    );
  }
  return raw.map(validatePackageSource);
}

async function installedLocalPackageSources(
  packages: readonly PackageSource[],
  packageManager: DefaultPackageManager,
  agentDir: string,
): Promise<PackageSource[]> {
  const installed: PackageSource[] = [];
  for (const entry of packages) {
    const source = typeof entry === "string" ? entry : entry.source;
    let installedPath: string | undefined;
    if (isNpmSource(source)) {
      const name = npmPackageName(source);
      if (name === undefined) throw unavailable();
      const root = resolve(agentDir, "npm", "node_modules");
      const candidate = resolve(root, ...name.split("/"));
      if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw unavailable();
      installedPath = candidate;
    } else {
      try {
        installedPath = packageManager.getInstalledPath(source, "user");
      } catch {
        throw unavailable();
      }
    }
    if (installedPath === undefined) throw unavailable();
    try {
      const info = await stat(installedPath);
      const getuid = process.getuid;
      if (
        (!info.isFile() && !info.isDirectory()) ||
        (getuid !== undefined && info.uid !== getuid() && info.uid !== 0) ||
        (info.mode & 0o022) !== 0
      ) {
        throw new Error();
      }
    } catch {
      throw unavailable();
    }
    installed.push(
      typeof entry === "string"
        ? installedPath
        : { ...entry, source: installedPath },
    );
  }
  return installed;
}

async function assertNormalizedPackageSourcesRemain(
  packages: readonly PackageSource[],
): Promise<void> {
  for (const entry of packages) {
    const path = typeof entry === "string" ? entry : entry.source;
    try {
      const info = await stat(path);
      if (!info.isFile() && !info.isDirectory()) throw new Error();
    } catch {
      throw unavailable();
    }
  }
}

function isNpmSource(source: string): boolean {
  return !(
    source.startsWith("/") ||
    source.startsWith("./") ||
    source.startsWith("../") ||
    source.startsWith("~/") ||
    source === "~" ||
    source.startsWith("git:") ||
    /^(?:https?|ssh|git):\/\//u.test(source)
  );
}

function npmPackageName(source: string): string | undefined {
  const spec = source.startsWith("npm:") ? source.slice(4) : source;
  let name = spec;
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    if (slash < 2) return undefined;
    const version = spec.indexOf("@", slash);
    if (version > slash) name = spec.slice(0, version);
  } else {
    const version = spec.lastIndexOf("@");
    if (version > 0) name = spec.slice(0, version);
  }
  return /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name) ? name : undefined;
}

function validatePackageSource(value: unknown): PackageSource {
  if (typeof value === "string") return boundedString(value);
  if (!isRecord(value)) throw invalidSettings();
  const allowed = new Set(["source", "autoload", "extensions", "skills", "prompts", "themes"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalidSettings();
  const source = boundedString(value.source);
  if (value.autoload !== undefined && typeof value.autoload !== "boolean") throw invalidSettings();
  const result: Exclude<PackageSource, string> = {
    source,
    ...(value.autoload === undefined ? {} : { autoload: value.autoload }),
  };
  for (const key of ["extensions", "skills", "prompts", "themes"] as const) {
    const filters = value[key];
    if (filters === undefined) continue;
    if (!Array.isArray(filters) || filters.length > MAX_INSTALLED_PACKAGE_FILTERS) {
      throw invalidSettings();
    }
    result[key] = filters.map(boundedString);
  }
  return result;
}

function boundedString(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_INSTALLED_PACKAGE_PATH_BYTES ||
    /[\r\n\0]/u.test(value)
  ) {
    throw invalidSettings();
  }
  return value;
}

function enabledPackagePaths(resources: ResolvedPaths["extensions"]): string[] {
  const paths = resources
    .filter((resource) => resource.enabled && resource.metadata.origin === "package")
    .map((resource) => resource.path);
  if (paths.length > MAX_INSTALLED_PACKAGE_RESOURCES_PER_TYPE) {
    throw new InstalledPiPackageError(
      "installed_package_resource_limit",
      "installed Pi package resources exceed their limit",
    );
  }
  const unique = new Set<string>();
  for (const path of paths) {
    if (
      !isAbsolute(path) ||
      Buffer.byteLength(path, "utf8") > MAX_INSTALLED_PACKAGE_PATH_BYTES ||
      /[\r\n\0]/u.test(path)
    ) {
      throw new InstalledPiPackageError(
        "installed_package_resource_invalid",
        "installed Pi package resources are invalid",
      );
    }
    unique.add(path);
  }
  return [...unique];
}

function unavailable(): InstalledPiPackageError {
  return new InstalledPiPackageError(
    "installed_package_unavailable",
    "one or more Pi packages are not installed; install them with the Pi CLI",
  );
}

function invalidSettings(): InstalledPiPackageError {
  return new InstalledPiPackageError(
    "installed_package_settings_invalid",
    "installed Pi package settings are invalid",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
