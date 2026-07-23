import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const artifactDir = new URL("../artifacts/", import.meta.url);
const distDir = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const mime = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

async function startStaticServer() {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const relativePath = pathname === "/dash/" || pathname === "/dash" ? "index.html" : pathname.replace(/^\/dash\//, "");
      const file = resolve(distDir, relativePath);
      if (file !== distDir && !file.startsWith(`${distDir}${sep}`)) {
        response.writeHead(404).end();
        return;
      }
      const bytes = await readFile(file);
      response.writeHead(200, {
        "content-type": mime.get(extname(file)) ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("capture server did not bind a TCP port");
  return { server, url: `http://127.0.0.1:${address.port}/dash/` };
}

await mkdir(artifactDir, { recursive: true });
const staticServer = process.env.DASH_CAPTURE_URL ? undefined : await startStaticServer();
const url = process.env.DASH_CAPTURE_URL ?? staticServer?.url;
if (!url) throw new Error("Dash capture URL could not be resolved");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, colorScheme: "dark" });
const harnessNavigationSamples = [];
const appFirstRowsSamples = [];
const navigationFirstRowsSamples = [];
for (let index = 0; index < 20; index += 1) {
  const startedAt = performance.now();
  await page.goto(`${url}?fixture=1`, { waitUntil: "networkidle" });
  await page.locator("[data-session-row]").first().waitFor();
  harnessNavigationSamples.push(performance.now() - startedAt);
  const metrics = await page.evaluate(() => window.__DASH_METRICS__);
  if (metrics?.firstRowsMs !== undefined) appFirstRowsSamples.push(metrics.firstRowsMs);
  if (metrics?.navigationFirstRowsMs !== undefined) navigationFirstRowsSamples.push(metrics.navigationFirstRowsMs);
}
const search = page.getByTestId("session-search");
const searchStartedAt = performance.now();
await search.fill("session-09999");
await page.getByText(/09999/).waitFor();
const harnessSearchMs = performance.now() - searchStartedAt;
await search.fill("");
await page.waitForTimeout(120);
const frameIntervals = await page.evaluate(async () => {
  const samples = [];
  let previous = performance.now();
  for (let index = 0; index < 60; index += 1) {
    await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
    const now = performance.now();
    samples.push(now - previous);
    previous = now;
  }
  return samples;
});
const browserMetrics = await page.evaluate(() => ({
  app: window.__DASH_METRICS__,
  visibleSessionRows: document.querySelectorAll("[data-session-row]").length,
  visibleTranscriptRows: document.querySelectorAll("[data-transcript-row]").length,
}));
await page.getByRole("button", { name: "ready" }).click();
await page.screenshot({ path: new URL("nord-midnight-reference.png", artifactDir).pathname, fullPage: true });
const treeStartedAt = performance.now();
await page.locator('[data-pane-id="primary"]').getByRole("button", { name: "Open session branch tree" }).click();
const treeNavigator = page.locator('[data-pane-id="primary"]').getByRole("complementary", { name: "Session branch tree" });
await treeNavigator.getByRole("treeitem").first().waitFor();
const treeLoadMs = performance.now() - treeStartedAt;
const visibleTreeRows = await treeNavigator.getByRole("treeitem").count();
await treeNavigator.getByRole("treeitem", { name: /^experiment / }).click();
await treeNavigator.getByRole("button", { name: "Compare with active" }).click();
await page.screenshot({ path: new URL("nord-midnight-session-tree.png", artifactDir).pathname, fullPage: true });
await treeNavigator.getByRole("button", { name: "Close session tree" }).click();
await page.getByText("Browse by state and source").click();
await page.getByRole("button", { name: /Open information for/ }).first().focus();
await page.getByRole("tooltip").waitFor();
await page.screenshot({ path: new URL("nord-midnight-sidebar-details.png", artifactDir).pathname, fullPage: true });
await page.getByRole("button", { name: "Settings" }).click();
const settingsDialog = page.getByRole("dialog", { name: "Settings" });
await settingsDialog.getByRole("radio", { name: /Nord Frost/ }).click();
await page.screenshot({ path: new URL("nord-frost-settings.png", artifactDir).pathname, fullPage: true });
await settingsDialog.getByRole("button", { name: "Revert to configured defaults" }).click();
await settingsDialog.getByRole("button", { name: "Done" }).click();
await page.locator('[data-pane-id="primary"]').getByRole("button", { name: "Split pane vertically" }).click();
await page.waitForFunction(() => /workspace r(?:[2-9]|\d{2,})/.test(document.querySelector(".workspace-notice")?.textContent ?? ""));
await page.waitForTimeout(180);
await page.screenshot({ path: new URL("nord-midnight-workspace-split.png", artifactDir).pathname, fullPage: true });
await page.locator('[data-pane-id="primary"]').getByRole("button", { name: "Switch to TUI presentation" }).click();
await page.locator('[data-pane-id="primary"] .tui-grid__row').first().waitFor();
await page.waitForTimeout(120);
await page.screenshot({ path: new URL("nord-midnight-tui-grid.png", artifactDir).pathname, fullPage: true });
const largeTreePage = await browser.newPage({ viewport: { width: 1440, height: 960 }, colorScheme: "dark" });
await largeTreePage.goto(`${url}?fixture=1&state=ready&tree=large`, { waitUntil: "networkidle" });
const largeTreeStartedAt = performance.now();
await largeTreePage.locator('[data-pane-id="primary"]').getByRole("button", { name: "Open session branch tree" }).click();
const largeTreeNavigator = largeTreePage.locator('[data-pane-id="primary"]').getByRole("complementary", { name: "Session branch tree" });
await largeTreeNavigator.getByRole("heading", { name: /10,000 entries/ }).waitFor();
const largeTreeLoadMs = performance.now() - largeTreeStartedAt;
const largeTreeVisibleRows = await largeTreeNavigator.getByRole("treeitem").count();
await largeTreePage.close();
await browser.close();
await new Promise((resolveClose, reject) => {
  if (!staticServer) return resolveClose();
  staticServer.server.close((error) => error ? reject(error) : resolveClose());
});
const percentile95 = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
};
const frameP95 = percentile95(frameIntervals);
let existing = {};
try { existing = JSON.parse(await readFile(new URL("performance.json", artifactDir), "utf8")); } catch {}
const report = {
  ...existing,
  browser: {
    measuredAt: new Date().toISOString(),
    browser: "Playwright Chromium 149 headless",
    viewport: "1440x960",
    fixtureSessions: 10_000,
    harnessNavigationP95Ms: Number(percentile95(harnessNavigationSamples).toFixed(2)),
    appFirstRowsP95Ms: Number(percentile95(appFirstRowsSamples).toFixed(2)),
    navigationFirstRowsP95Ms: Number(percentile95(navigationFirstRowsSamples).toFixed(2)),
    firstRowsSamples: {
      harness: harnessNavigationSamples.map((value) => Number(value.toFixed(2))),
      app: appFirstRowsSamples,
      navigation: navigationFirstRowsSamples,
    },
    harnessSearchMs: Number(harnessSearchMs.toFixed(2)),
    appSearchMs: browserMetrics.app?.lastSearchMs,
    treeLoadMs: Number(treeLoadMs.toFixed(2)),
    visibleTreeRows,
    largeTreeLoadMs: Number(largeTreeLoadMs.toFixed(2)),
    largeTreeVisibleRows,
    animationFrameCadenceP95Ms: Number(frameP95.toFixed(2)),
    animationFrameCadenceMaxMs: Number(Math.max(...frameIntervals).toFixed(2)),
    streamFrameWorkMaxMs: browserMetrics.app?.maxFrameWorkMs,
    ...browserMetrics,
  },
};
await writeFile(new URL("performance.json", artifactDir), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.browser, null, 2));
