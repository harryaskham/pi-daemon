import { defineConfig } from "@playwright/test";

const port = Number(process.env.DASH_TEST_PORT ?? 4174);

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}/dash/`,
    colorScheme: "dark",
    viewport: { width: 1440, height: 960 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/dash/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
