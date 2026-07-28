#!/usr/bin/env node
// Preflight for `npm run e2e:nix`: prove that the Nix development shell exports
// browsers matching the pinned @playwright/test build before Playwright starts
// a Vite build and a browser launch that would otherwise fail late and
// unhelpfully (bd-185516).
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import {
  BROWSERS_PATH_ENV,
  DRIVER_VERSION_ENV,
  evaluateNixPlaywrightBrowsers,
  requiredBrowserDirectories,
} from "./playwright-nix-browsers.mjs";

const require = createRequire(import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const packageJsonPath = require.resolve("playwright-core/package.json");
  const packageRoot = packageJsonPath.slice(0, -"/package.json".length);
  const [{ version: packageVersion }, browsersJson] = await Promise.all([
    readJson(packageJsonPath),
    readJson(join(packageRoot, "browsers.json")),
  ]);

  const browsersPath = process.env[BROWSERS_PATH_ENV];
  const result = evaluateNixPlaywrightBrowsers({
    browsersPath,
    driverVersion: process.env[DRIVER_VERSION_ENV],
    packageVersion,
    required: requiredBrowserDirectories(browsersJson),
    directoryExists: (directory) => existsSync(join(String(browsersPath), directory)),
  });

  if (!result.ok) {
    process.stderr.write(`playwright-nix preflight failed (${result.code}): ${result.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${result.message}\n`);
}

await main();
