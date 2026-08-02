#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const WEB_WORKSPACE = "@harryaskham/pi-daemon-dash";
export const WEB_WORKSPACE_SCRIPTS = Object.freeze([
  "dev",
  "build",
  "test",
  "e2e",
  "e2e:nix",
  "e2e:smoke",
  "bundle:report",
]);

const MAX_FORWARDED_ARGUMENTS = 64;
const MAX_ARGUMENT_CHARS = 4_096;
const MAX_AGGREGATE_CHARS = 32_768;

/**
 * Build one nested npm workspace invocation with an explicit argument boundary.
 *
 * A root script such as `npm run web:e2e -- --grep x` has its trailing flags
 * appended to the root command. If that command is another `npm run`, npm can
 * consume `--grep` as npm configuration instead of passing it to Playwright.
 * This wrapper receives the root arguments as ordinary Node argv and inserts
 * the inner `--` itself, so every flag belongs to the workspace script.
 */
export function webWorkspaceRunArguments(script, forwarded = []) {
  if (!WEB_WORKSPACE_SCRIPTS.includes(script)) {
    throw new Error("unsupported web workspace script");
  }
  if (!Array.isArray(forwarded) || forwarded.length > MAX_FORWARDED_ARGUMENTS) {
    throw new Error(`web workspace arguments exceed ${MAX_FORWARDED_ARGUMENTS} entries`);
  }
  let aggregateChars = 0;
  for (const argument of forwarded) {
    if (
      typeof argument !== "string" ||
      argument.length > MAX_ARGUMENT_CHARS ||
      argument.includes("\u0000")
    ) {
      throw new Error(`web workspace argument is invalid or exceeds ${MAX_ARGUMENT_CHARS} characters`);
    }
    aggregateChars += argument.length;
    if (aggregateChars > MAX_AGGREGATE_CHARS) {
      throw new Error(`web workspace arguments exceed ${MAX_AGGREGATE_CHARS} aggregate characters`);
    }
  }
  return [
    "run",
    script,
    "--workspace",
    WEB_WORKSPACE,
    ...(forwarded.length === 0 ? [] : ["--", ...forwarded]),
  ];
}

export function runWebWorkspaceScript(script, forwarded = []) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, webWorkspaceRunArguments(script, forwarded), {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) {
    process.kill(process.pid, result.signal);
    return 1;
  }
  return result.status ?? 1;
}

function main() {
  const script = process.argv[2];
  if (script === undefined) throw new Error("web workspace script is required");
  process.exitCode = runWebWorkspaceScript(script, process.argv.slice(3));
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
