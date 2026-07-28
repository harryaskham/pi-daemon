// Pure helpers that decide whether a Nix-provided Playwright browser bundle can
// serve the exact @playwright/test build this workspace pins.
//
// Playwright resolves browsers by revision, so a Nix `playwright-driver` whose
// version differs from the npm package silently yields "Executable doesn't
// exist". These helpers turn that into one actionable message before the suite
// launches a browser. They stay free of filesystem and environment access so
// they can be unit tested deterministically.

export const BROWSERS_PATH_ENV = "PLAYWRIGHT_BROWSERS_PATH";
export const DRIVER_VERSION_ENV = "PI_DAEMON_PLAYWRIGHT_DRIVER_VERSION";
export const NIX_SHELL_COMMAND = "nix develop .#e2e";

// Browsers the Dash suite actually launches. `playwright.config.ts` declares no
// explicit projects, so Playwright uses chromium plus its headless shell.
export const REQUIRED_BROWSER_NAMES = Object.freeze(["chromium", "chromium-headless-shell"]);

/**
 * Playwright stores each browser under `<name with underscores>-<revision>`.
 * @param {string} name
 * @param {string} revision
 * @returns {string}
 */
export function browserDirectoryName(name, revision) {
  return `${String(name).replaceAll("-", "_")}-${revision}`;
}

/**
 * Select the required browser entries from a `playwright-core/browsers.json`
 * document.
 * @param {{browsers?: Array<{name?: string, revision?: string|number}>}} browsersJson
 * @param {readonly string[]} [names]
 * @returns {Array<{name: string, revision: string, directory: string}>}
 */
export function requiredBrowserDirectories(browsersJson, names = REQUIRED_BROWSER_NAMES) {
  const entries = Array.isArray(browsersJson?.browsers) ? browsersJson.browsers : [];
  return names.map((name) => {
    const entry = entries.find((candidate) => candidate?.name === name);
    if (!entry || entry.revision === undefined || entry.revision === null) {
      return { name, revision: "", directory: "" };
    }
    const revision = String(entry.revision);
    return { name, revision, directory: browserDirectoryName(name, revision) };
  });
}

function versionMismatchHint(driverVersion, packageVersion) {
  if (!driverVersion) {
    return (
      `The npm workspace pins @playwright/test ${packageVersion}. Enter the shell with ` +
      `\`${NIX_SHELL_COMMAND}\` so the audited browsers and their version are exported together.`
    );
  }
  if (driverVersion === packageVersion) {
    return (
      `The Nix playwright-driver (${driverVersion}) matches @playwright/test ` +
      `(${packageVersion}), so the bundle itself is incomplete. Rebuild it with ` +
      "`nix build nixpkgs#playwright-driver.browsers`."
    );
  }
  return (
    `Version drift: Nix playwright-driver is ${driverVersion} but the npm workspace pins ` +
    `@playwright/test ${packageVersion}. Align them — pin @playwright/test to ${driverVersion}, ` +
    "or move the flake's nixpkgs input to a revision whose playwright-driver matches the npm pin."
  );
}

/**
 * @param {{
 *   browsersPath?: string,
 *   driverVersion?: string,
 *   packageVersion: string,
 *   required: Array<{name: string, revision: string, directory: string}>,
 *   directoryExists: (directory: string) => boolean,
 * }} input
 * @returns {{ok: boolean, code: string, message: string}}
 */
export function evaluateNixPlaywrightBrowsers({
  browsersPath,
  driverVersion,
  packageVersion,
  required,
  directoryExists,
}) {
  const trimmedPath = typeof browsersPath === "string" ? browsersPath.trim() : "";
  if (trimmedPath === "") {
    return {
      ok: false,
      code: "browsers_path_missing",
      message:
        `${BROWSERS_PATH_ENV} is not set, so Playwright would fall back to a downloaded browser ` +
        `that cannot run without host libraries. Run the suite inside \`${NIX_SHELL_COMMAND}\`.`,
    };
  }

  const unresolved = required.filter((entry) => entry.revision === "");
  if (unresolved.length > 0) {
    const names = unresolved.map((entry) => entry.name).join(", ");
    return {
      ok: false,
      code: "browser_revision_unknown",
      message:
        `playwright-core ${packageVersion} declares no revision for: ${names}. ` +
        "The installed Playwright build is unexpected; reinstall the workspace with `npm ci`.",
    };
  }

  const missing = required.filter((entry) => !directoryExists(entry.directory));
  if (missing.length > 0) {
    const detail = missing.map((entry) => `${entry.directory} (${entry.name})`).join(", ");
    return {
      ok: false,
      code: "browser_revision_missing",
      message:
        `${BROWSERS_PATH_ENV}=${trimmedPath} has no ${detail}. ` +
        versionMismatchHint(driverVersion, packageVersion),
    };
  }

  const resolved = required.map((entry) => entry.directory).join(", ");
  return {
    ok: true,
    code: "ok",
    message: `Playwright ${packageVersion} will use Nix browsers from ${trimmedPath}: ${resolved}.`,
  };
}
