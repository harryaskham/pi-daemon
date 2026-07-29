#!/usr/bin/env node
/**
 * Restore `integrity` on lockfile entries whose upstream shrinkwrap omitted it.
 *
 * Pi SDK 0.82.1 publishes an `npm-shrinkwrap.json` in which its three sibling
 * `@earendil-works` packages carry a `resolved` tarball URL but no `integrity`.
 * npm faithfully carries that omission into our `package-lock.json`, and a
 * lockfile entry with a registry URL and no integrity panics the Nix npm
 * prefetcher (see `test/pi-sdk-compatibility.test.mjs`).
 *
 * The repair is not an invented hash: it is the registry's own published
 * `dist.integrity` for the exact name@version already named by the entry. When
 * the same tarball also appears elsewhere in the lock with integrity intact,
 * that value is used and cross-checked against the registry instead.
 *
 *   node scripts/repair-lock-integrity.mjs           # rewrite package-lock.json
 *   node scripts/repair-lock-integrity.mjs --check   # fail if repair is needed
 *
 * Only `https://registry.npmjs.org/` URLs are repaired. An entry resolved from
 * any other host is reported and left alone, because a mirror can rewrite URLs
 * and its integrity is not the public registry's to vouch for.
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { argv, exit } from "node:process";
import { promisify } from "node:util";

const run = promisify(execFile);
const PUBLIC_REGISTRY = "https://registry.npmjs.org/";

const nameAndVersion = (path, entry) => {
  if (typeof entry.version !== "string") return undefined;
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  if (index < 0) return undefined;
  return { name: path.slice(index + marker.length), version: entry.version };
};

const registryIntegrity = async (name, version) => {
  const { stdout } = await run("npm", ["view", `${name}@${version}`, "dist.integrity"], {
    timeout: 60_000,
  });
  const value = stdout.trim();
  if (!value.startsWith("sha512-") && !value.startsWith("sha1-")) {
    throw new Error(`registry returned no usable integrity for ${name}@${version}: ${value}`);
  }
  return value;
};

const main = async () => {
  const checkOnly = argv.includes("--check");
  const lockPath = new URL("../package-lock.json", import.meta.url);
  const raw = await readFile(lockPath, "utf8");
  const lock = JSON.parse(raw);

  const damaged = [];
  const foreign = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (typeof entry.resolved !== "string" || !/^https?:/.test(entry.resolved)) continue;
    if (typeof entry.integrity === "string") continue;
    if (!entry.resolved.startsWith(PUBLIC_REGISTRY)) {
      foreign.push({ path, resolved: entry.resolved });
      continue;
    }
    const identity = nameAndVersion(path, entry);
    if (identity === undefined) {
      foreign.push({ path, resolved: entry.resolved });
      continue;
    }
    damaged.push({ path, entry, ...identity });
  }

  for (const { path, resolved } of foreign) {
    console.error(`unrepairable: ${path} resolved from ${resolved}`);
  }

  if (damaged.length === 0) {
    if (foreign.length > 0) exit(1);
    console.log("every lockfile entry with a registry URL carries integrity");
    return;
  }

  if (checkOnly) {
    for (const { path, name, version } of damaged) {
      console.error(`missing integrity: ${path} (${name}@${version})`);
    }
    console.error(
      `\n${damaged.length} lockfile entr${damaged.length === 1 ? "y" : "ies"} would panic the Nix npm prefetcher.` +
        `\nRun: npm run lock:repair-integrity`,
    );
    exit(1);
  }

  // A sibling entry for the same tarball is the strongest available check: it
  // was written by npm from the registry response, so agreement means the value
  // fetched here is the one npm itself recorded for this exact artifact.
  const siblings = new Map();
  for (const entry of Object.values(lock.packages ?? {})) {
    if (typeof entry.resolved === "string" && typeof entry.integrity === "string") {
      siblings.set(entry.resolved, entry.integrity);
    }
  }

  for (const { path, entry, name, version } of damaged) {
    const fetched = await registryIntegrity(name, version);
    const sibling = siblings.get(entry.resolved);
    if (sibling !== undefined && sibling !== fetched) {
      throw new Error(
        `integrity disagreement for ${name}@${version}: lock sibling has ${sibling}, registry reports ${fetched}`,
      );
    }
    entry.integrity = fetched;
    console.log(
      `repaired ${path} (${name}@${version})${sibling === undefined ? "" : " — matches existing lock entry"}`,
    );
  }

  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(
    `\nrewrote package-lock.json; re-run the Nix deps hash refresh because the lock changed`,
  );
};

await main();
