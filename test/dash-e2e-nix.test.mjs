import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BROWSERS_PATH_ENV,
  browserDirectoryName,
  evaluateNixPlaywrightBrowsers,
  requiredBrowserDirectories,
} from "../web/scripts/playwright-nix-browsers.mjs";

const repositoryRoot = new URL("../", import.meta.url);

async function readRepositoryFile(relativePath) {
  return readFile(fileURLToPath(new URL(relativePath, repositoryRoot)), "utf8");
}

const BROWSERS_JSON = {
  browsers: [
    { name: "chromium", revision: "1223" },
    { name: "chromium-headless-shell", revision: 1223 },
    { name: "firefox", revision: "1522" },
  ],
};

const REQUIRED = requiredBrowserDirectories(BROWSERS_JSON);

test("nix browser directories follow Playwright's underscore-revision layout", () => {
  assert.equal(browserDirectoryName("chromium", "1223"), "chromium-1223");
  assert.equal(
    browserDirectoryName("chromium-headless-shell", "1223"),
    "chromium_headless_shell-1223",
  );
  assert.deepEqual(
    REQUIRED.map((entry) => entry.directory),
    ["chromium-1223", "chromium_headless_shell-1223"],
  );
});

test("a matching Nix bundle is accepted without touching the network", () => {
  const present = new Set(["chromium-1223", "chromium_headless_shell-1223"]);
  const result = evaluateNixPlaywrightBrowsers({
    browsersPath: "/nix/store/eeee-playwright-browsers",
    driverVersion: "1.60.0",
    packageVersion: "1.60.0",
    required: REQUIRED,
    directoryExists: (directory) => present.has(directory),
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, "ok");
  assert.match(result.message, /chromium-1223/);
});

test("a missing browsers path names the documented shell instead of downloading", () => {
  for (const browsersPath of [undefined, "", "   "]) {
    const result = evaluateNixPlaywrightBrowsers({
      browsersPath,
      packageVersion: "1.60.0",
      required: REQUIRED,
      directoryExists: () => true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "browsers_path_missing");
    assert.match(result.message, /nix develop \.#e2e/);
    assert.match(result.message, new RegExp(BROWSERS_PATH_ENV));
  }
});

test("driver drift reports both versions and the exact missing revision", () => {
  const result = evaluateNixPlaywrightBrowsers({
    browsersPath: "/nix/store/ffff-playwright-browsers",
    driverVersion: "1.55.0",
    packageVersion: "1.60.0",
    required: REQUIRED,
    directoryExists: () => false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "browser_revision_missing");
  assert.match(result.message, /chromium-1223/);
  assert.match(result.message, /chromium_headless_shell-1223/);
  assert.match(result.message, /1\.55\.0/);
  assert.match(result.message, /1\.60\.0/);
});

test("an equal-version bundle that is still incomplete blames the bundle, not the pins", () => {
  const result = evaluateNixPlaywrightBrowsers({
    browsersPath: "/nix/store/gggg-playwright-browsers",
    driverVersion: "1.60.0",
    packageVersion: "1.60.0",
    required: REQUIRED,
    directoryExists: () => false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "browser_revision_missing");
  assert.match(result.message, /playwright-driver\.browsers/);
});

test("an unknown browser revision asks for a reinstall rather than a version change", () => {
  const result = evaluateNixPlaywrightBrowsers({
    browsersPath: "/nix/store/hhhh-playwright-browsers",
    driverVersion: "1.60.0",
    packageVersion: "1.60.0",
    required: requiredBrowserDirectories({ browsers: [{ name: "firefox", revision: "1522" }] }),
    directoryExists: () => true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "browser_revision_unknown");
  assert.match(result.message, /npm ci/);
});

test("the repository wires one documented Nix path for Dash browser acceptance", async () => {
  const [flake, webPackage, justfile] = await Promise.all([
    readRepositoryFile("flake.nix"),
    readRepositoryFile("web/package.json"),
    readRepositoryFile("Justfile"),
  ]);

  assert.match(flake, /e2e = pkgs\.mkShell/);
  assert.match(flake, /PLAYWRIGHT_BROWSERS_PATH = "\$\{playwright\.browsers\}"/);
  assert.match(flake, /PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"/);
  assert.match(flake, /PI_DAEMON_PLAYWRIGHT_DRIVER_VERSION = playwright\.version/);

  const scripts = JSON.parse(webPackage).scripts;
  assert.equal(scripts["e2e:nix"], "node scripts/check-playwright-browsers.mjs && playwright test");
  assert.equal(scripts["e2e:check"], "node scripts/check-playwright-browsers.mjs");

  assert.match(justfile, /^dash-e2e \*ARGS:$/m);
  assert.match(justfile, /nix develop \.#e2e --command npm run e2e:nix/);
});
