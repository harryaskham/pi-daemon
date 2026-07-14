#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function readReleaseState(root = process.cwd()) {
  const absoluteRoot = resolve(root);
  const [packageText, lockText, sourceText, flakeText, changelog] = await Promise.all([
    readFile(resolve(absoluteRoot, "package.json"), "utf8"),
    readFile(resolve(absoluteRoot, "package-lock.json"), "utf8"),
    readFile(resolve(absoluteRoot, "src/version.ts"), "utf8"),
    readFile(resolve(absoluteRoot, "flake.nix"), "utf8"),
    readFile(resolve(absoluteRoot, "CHANGELOG.md"), "utf8"),
  ]);
  const packageJson = JSON.parse(packageText);
  const packageLock = JSON.parse(lockText);
  const packageVersion = requiredString(packageJson.version, "package.json version");
  const lockVersion = requiredString(
    packageLock?.packages?.[""]?.version,
    "package-lock.json root package version",
  );
  const sourceVersion = captureVersion(
    sourceText,
    /PI_DAEMON_VERSION\s*=\s*"([^"]+)"/,
    "src/version.ts PI_DAEMON_VERSION",
  );
  const flakeVersion = captureVersion(
    flakeText,
    /pname\s*=\s*"pi-daemon";[\s\S]{0,512}?version\s*=\s*"([^"]+)"/,
    "flake.nix pi-daemon package version",
  );
  const changelogMatch = changelog.match(
    new RegExp(`^## ${escapeRegex(packageVersion)} — ([^\\r\\n]+)$`, "m"),
  );
  if (changelogMatch === null) {
    throw new Error(`CHANGELOG.md has no section for ${packageVersion}`);
  }
  return {
    version: packageVersion,
    versions: {
      package: packageVersion,
      lock: lockVersion,
      source: sourceVersion,
      flake: flakeVersion,
    },
    changelogLabel: changelogMatch[1].trim(),
  };
}

export async function checkRelease(options = {}) {
  const state = await readReleaseState(options.root);
  if (!SEMVER.test(state.version)) {
    throw new Error(`package version is not MAJOR.MINOR.PATCH: ${state.version}`);
  }
  for (const [source, version] of Object.entries(state.versions)) {
    if (version !== state.version) {
      throw new Error(`${source} version ${version} does not match package version ${state.version}`);
    }
  }

  if (options.tag !== undefined) {
    const expectedTag = `v${state.version}`;
    if (options.tag !== expectedTag) {
      throw new Error(`release tag ${options.tag} does not match ${expectedTag}`);
    }
    if (!RELEASE_DATE.test(state.changelogLabel) || !isIsoDate(state.changelogLabel)) {
      throw new Error(
        `CHANGELOG.md section ${state.version} must use an ISO release date, not '${state.changelogLabel}'`,
      );
    }
  } else if (state.changelogLabel !== "unreleased") {
    if (!RELEASE_DATE.test(state.changelogLabel) || !isIsoDate(state.changelogLabel)) {
      throw new Error(
        `CHANGELOG.md section ${state.version} must be 'unreleased' or an ISO release date`,
      );
    }
  }

  for (const [artifact, version] of options.artifactVersions ?? []) {
    if (version !== state.version) {
      throw new Error(
        `${artifact} artifact version ${version} does not match package version ${state.version}`,
      );
    }
  }
  return state;
}

function parseArguments(argv) {
  const options = { artifactVersions: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--root" || argument === "--tag" || argument === "--artifact-version") {
      if (value === undefined) throw new Error(`${argument} requires a value`);
      if (argument === "--root") options.root = value;
      if (argument === "--tag") options.tag = value;
      if (argument === "--artifact-version") {
        const separator = value.indexOf("=");
        if (separator <= 0 || separator === value.length - 1) {
          throw new Error("--artifact-version must be LABEL=VERSION");
        }
        options.artifactVersions.push([value.slice(0, separator), value.slice(separator + 1)]);
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const state = await checkRelease(parseArguments(process.argv.slice(2)));
  process.stdout.write(`release invariants ok: ${state.version}\n`);
}

function captureVersion(text, pattern, label) {
  const match = text.match(pattern);
  if (match?.[1] === undefined) throw new Error(`could not read ${label}`);
  return match[1];
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`could not read ${label}`);
  return value;
}

function isIsoDate(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "release invariant failure"}\n`);
    process.exitCode = 1;
  });
}
