/**
 * Preflight: prove the audited browser can actually launch here.
 *
 * Playwright reports a browser that dies during startup as
 * `browserContext.newPage: Target page, context or browser has been closed`,
 * once per scenario, minutes into a run, with the browser's own stderr
 * swallowed unless `DEBUG=pw:browser` is set. That symptom names neither the
 * cause nor the environment, which cost two CI round trips on bd-df1c84 and
 * bd-2c7a19.
 *
 * This launches Chromium with the same options the suite uses, and on failure
 * reports the browser's own diagnostics plus the environment facts that decide
 * whether a launch is possible at all. It runs in seconds, so a runner or
 * developer machine that cannot start the browser is told why immediately
 * instead of after the suite times out.
 */
import { existsSync, statfsSync } from "node:fs";
import { chromium } from "@playwright/test";

import { browserLaunchOptions } from "../playwright-launch.mjs";

function environmentReport() {
  const lines = [];
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  lines.push(`PLAYWRIGHT_BROWSERS_PATH=${browsersPath ?? "(unset)"}`);
  if (browsersPath !== undefined) {
    lines.push(`  exists=${existsSync(browsersPath)}`);
  }
  lines.push(`launch args=${JSON.stringify(browserLaunchOptions().args ?? [])}`);
  lines.push(`uid=${typeof process.getuid === "function" ? process.getuid() : "n/a"}`);
  try {
    const shm = statfsSync("/dev/shm");
    const totalMiB = Math.round((shm.bsize * shm.blocks) / 1048576);
    const freeMiB = Math.round((shm.bsize * shm.bavail) / 1048576);
    lines.push(`/dev/shm total=${totalMiB}MiB free=${freeMiB}MiB`);
  } catch (error) {
    lines.push(`/dev/shm unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Chromium's default sandbox needs unprivileged user namespaces; a hardened
  // runner disables them, which is the classic cause of a silent launch death.
  for (const knob of [
    "/proc/sys/user/max_user_namespaces",
    "/proc/sys/kernel/unprivileged_userns_clone",
  ]) {
    lines.push(`${knob} present=${existsSync(knob)}`);
  }
  return lines;
}

const started = Date.now();
try {
  const browser = await chromium.launch(browserLaunchOptions());
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent("<title>launch check</title>");
  const title = await page.title();
  await browser.close();
  if (title !== "launch check") {
    throw new Error(`browser launched but returned an unexpected title: ${title}`);
  }
  console.log(`Browser launch check passed in ${Date.now() - started}ms.`);
} catch (error) {
  console.error("Browser launch check FAILED. The suite cannot run in this environment.\n");
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  console.error("\nEnvironment:");
  for (const line of environmentReport()) console.error(`  ${line}`);
  console.error(
    "\nRe-run with DEBUG=pw:browser to see the browser's own stderr, which names the cause.",
  );
  process.exitCode = 1;
}
