#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, open, opendir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FORMAT_VERSION = 1;
const MARKER_NAME = ".source-build-fingerprint.json";
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_AGGREGATE_BYTES = 64 * 1024 * 1024;
const MAX_MARKER_BYTES = 4 * 1024;
const REMEDIATION = "run `npm run test:src -- <test-file>` (or `npm run build:src`) to refresh dist";

export async function computeSourceFingerprint(root = repositoryRoot()) {
  const sourceRoot = join(root, "src");
  const files = await collectSourceFiles(sourceRoot);
  const hash = createHash("sha256");
  let aggregateBytes = 0;
  for (const path of files) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("source fingerprint accepts regular files only");
    }
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(`source fingerprint file exceeds ${MAX_FILE_BYTES} bytes`);
    }
    aggregateBytes += info.size;
    if (aggregateBytes > MAX_AGGREGATE_BYTES) {
      throw new Error(`source fingerprint exceeds ${MAX_AGGREGATE_BYTES} aggregate bytes`);
    }
    const relativePath = relative(sourceRoot, path).split(sep).join("/");
    hash.update(relativePath, "utf8");
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return {
    formatVersion: FORMAT_VERSION,
    algorithm: "sha256",
    digest: hash.digest("base64url"),
    fileCount: files.length,
    aggregateBytes,
  };
}

export async function writeSourceDistFingerprint(root = repositoryRoot()) {
  const marker = markerPath(root);
  const fingerprint = await computeSourceFingerprint(root);
  await atomicWrite(marker, `${JSON.stringify(fingerprint)}\n`);
  return fingerprint;
}

export async function checkSourceDistFingerprint(root = repositoryRoot()) {
  const current = await computeSourceFingerprint(root);
  const marker = markerPath(root);
  let built;
  try {
    const info = await lstat(marker);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_MARKER_BYTES) {
      return { status: "missing", current };
    }
    built = JSON.parse(await readFile(marker, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { status: "missing", current };
    }
    if (error instanceof SyntaxError) return { status: "invalid", current };
    throw error;
  }
  if (!validFingerprint(built)) return { status: "invalid", current };
  if (built.digest !== current.digest || built.fileCount !== current.fileCount) {
    return { status: "stale", current, built };
  }
  return { status: "current", current, built };
}

export async function warnIfSourceDistStale(root = repositoryRoot(), write = process.stderr.write.bind(process.stderr)) {
  const result = await checkSourceDistFingerprint(root);
  if (result.status === "current") return result;
  const reason = result.status === "missing"
    ? "dist source fingerprint is missing"
    : result.status === "invalid"
      ? "dist source fingerprint is invalid"
      : "dist is stale relative to src/**";
  write(`test:unit warning: ${reason}; ${REMEDIATION}. Tests will still run.\n`);
  return result;
}

async function collectSourceFiles(sourceRoot) {
  const queue = [sourceRoot];
  const files = [];
  let entries = 0;
  while (queue.length > 0) {
    const directoryPath = queue.shift();
    const directory = await opendir(directoryPath);
    try {
      for await (const entry of directory) {
        entries += 1;
        if (entries > MAX_FILES) {
          throw new Error(`source fingerprint exceeds ${MAX_FILES} entries`);
        }
        const path = join(directoryPath, entry.name);
        if (entry.isSymbolicLink()) throw new Error("source fingerprint refuses symlinks");
        if (entry.isDirectory()) queue.push(path);
        else if (entry.isFile()) files.push(path);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  }
  files.sort((left, right) => left.localeCompare(right));
  return files;
}

async function atomicWrite(path, body) {
  const temporary = `${path}.tmp-${process.pid}`;
  await rm(temporary, { force: true });
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function validFingerprint(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.formatVersion === FORMAT_VERSION &&
    value.algorithm === "sha256" &&
    typeof value.digest === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.digest) &&
    Number.isSafeInteger(value.fileCount) &&
    value.fileCount >= 1 &&
    value.fileCount <= MAX_FILES &&
    Number.isSafeInteger(value.aggregateBytes) &&
    value.aggregateBytes >= 0 &&
    value.aggregateBytes <= MAX_AGGREGATE_BYTES;
}

function repositoryRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function markerPath(root) {
  return join(root, "dist", MARKER_NAME);
}

async function main() {
  if (process.argv.includes("--write")) {
    await writeSourceDistFingerprint();
    return;
  }
  await warnIfSourceDistStale();
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) await main();
