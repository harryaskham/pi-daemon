import { defineConfig } from "@playwright/test";

import { dashReporters } from "./playwright-reporters.mjs";
import { browserLaunchOptions } from "./playwright-launch.mjs";

const port = Number(process.env.DASH_TEST_PORT ?? 4174);
// The web server command type-checks and builds the SPA before serving it, so a
// cold checkout needs far more than Playwright's short default. Keep it bounded
// and overridable for slower or busier hosts (bd-185516).
const webServerTimeout = Number(process.env.DASH_TEST_WEBSERVER_TIMEOUT_MS ?? 180_000);
// Shared with web/scripts/check-browser-launch.mjs so the preflight proves the
// exact options the suite will use (bd-df1c84).
const launchOptions = browserLaunchOptions();

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
