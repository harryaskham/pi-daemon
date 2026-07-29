// Browser-resolution unit tests for the Nix Playwright path.
//
// INVARIANT: this file must never launch a browser. It lives in `test/`, which
// the standard `npm test` gate globs, and the gate must stay browser-free: CI
// runs it on plain Node runners with no Playwright browsers installed. Anything
// that drives a real page belongs in `web/e2e/`, behind `nix develop .#e2e`.
// The file is named for what it checks — resolution logic, version-drift
// detection, and refusal codes — rather than for the suite it supports, so the
// boundary is visible before someone adds a case on the wrong side of it.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { dashReporters, RUN_RECORD_FILE } from "../web/playwright-reporters.mjs";
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

test("the npm scripts wire the browser suite behind its preflight", async () => {
  // The e2e shell's own contract - which browsers it exports, that the download
  // fallback is refused, and that the driver matches the npm pin - is asserted
  // by evaluation in `nix flake check` (`nix/e2e-shell-check.nix`), not by
  // matching flake.nix source text here. Source matching was a proxy for the
  // property: it broke on a legitimate edit (bd-228b91) and survived a reformat
  // by luck rather than construction (bd-58a7fa). This test keeps only what it
  // can observe directly, which is the scripts themselves.
  const webPackage = await readRepositoryFile("web/package.json");

  const scripts = JSON.parse(webPackage).scripts;
  // Assert the properties that matter, not the literal command line. Adding a
  // preflight step to this pipeline is a legitimate change and must not fail a
  // test named for whether the path is wired at all (bd-228b91).
  const e2eNix = scripts["e2e:nix"];
  const stages = e2eNix.split("&&").map((stage) => stage.trim());
  // The browsers preflight runs first, so a version mismatch is reported before
  // a build or a browser launch is attempted.
  assert.equal(stages[0], "node scripts/check-playwright-browsers.mjs");
  // The run ends by invoking Playwright.
  assert.match(stages[stages.length - 1], /^playwright test\b/);
  // Chained with && throughout, so a failed preflight stops the run rather than
  // letting the suite start against a broken environment.
  assert.ok(stages.length >= 2, `expected a chained pipeline, got: ${e2eNix}`);
  assert.ok(
    stages.every((stage) => stage.length > 0),
    `every stage must be non-empty, got: ${e2eNix}`,
  );
  assert.match(scripts["e2e:check"], /^node scripts\/check-playwright-browsers\.mjs\b/);
});

test("the browser suite always writes a structured run record", () => {
  const reporters = dashReporters();
  // Readable progress stays first so a terminal run is unchanged.
  assert.deepEqual(reporters[0], ["list"]);
  const json = reporters.find((entry) => entry[0] === "json");
  assert.ok(json, "the suite must always emit a machine-readable record");
  assert.equal(json[1].outputFile, RUN_RECORD_FILE);
  // Beside the traces Playwright writes on failure, which CI already uploads.
  assert.match(RUN_RECORD_FILE, /^test-results\//);
  // Honour an explicit destination so a caller can keep runs side by side.
  assert.equal(dashReporters("test-results/other.json")[1][1].outputFile, "test-results/other.json");
});
