import { defineConfig } from "@playwright/test";

import { dashReporters } from "./playwright-reporters.mjs";

const port = Number(process.env.DASH_TEST_PORT ?? 4174);
// The web server command type-checks and builds the SPA before serving it, so a
// cold checkout needs far more than Playwright's short default. Keep it bounded
// and overridable for slower or busier hosts (bd-185516).
const webServerTimeout = Number(process.env.DASH_TEST_WEBSERVER_TIMEOUT_MS ?? 180_000);
// Chromium's sandbox needs user namespaces and a normally-sized /dev/shm. A
// hardened CI runner supplies neither, so the browser exits at launch and every
// scenario fails with "Target page, context or browser has been closed"
// (bd-df1c84). Relaxing that is only acceptable where the browser loads nothing
// but our own loopback build, so it is opt-in per environment and never the
// default on a developer machine.
const launchOptions =
  process.env.PI_DAEMON_E2E_NO_SANDBOX === "1"
    ? { args: ["--no-sandbox", "--disable-dev-shm-usage"] }
    : {};

export default defineConfig({
  testDir: "./e2e",
  reporter: dashReporters(),
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}/dash/`,
    colorScheme: "dark",
    viewport: { width: 1440, height: 960 },
    trace: "retain-on-failure",
    launchOptions,
  },
  webServer: {
    command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/dash/`,
    reuseExistingServer: false,
    timeout: webServerTimeout,
  },
});
