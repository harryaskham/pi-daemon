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
const startedAt = performance.now();
await page.goto(url, { waitUntil: "networkidle" });
await page.locator("[data-session-row]").first().waitFor();
const harnessNavigationMs = performance.now() - startedAt;
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
await page.getByText("Browse by state and source").click();
await page.getByRole("button", { name: /Open information for/ }).first().focus();
await page.getByRole("tooltip").waitFor();
await page.screenshot({ path: new URL("nord-midnight-sidebar-details.png", artifactDir).pathname, fullPage: true });
await browser.close();
await new Promise((resolveClose, reject) => {
  if (!staticServer) return resolveClose();
  staticServer.server.close((error) => error ? reject(error) : resolveClose());
});
const sorted = [...frameIntervals].sort((a, b) => a - b);
const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
let existing = {};
try { existing = JSON.parse(await readFile(new URL("performance.json", artifactDir), "utf8")); } catch {}
const report = {
  ...existing,
  browser: {
    measuredAt: new Date().toISOString(),
    browser: "Playwright Chromium 149 headless",
    viewport: "1440x960",
    fixtureSessions: 10_000,
    harnessNavigationMs: Number(harnessNavigationMs.toFixed(2)),
    appFirstRowsMs: browserMetrics.app?.firstRowsMs,
    navigationFirstRowsMs: browserMetrics.app?.navigationFirstRowsMs,
    harnessSearchMs: Number(harnessSearchMs.toFixed(2)),
    appSearchMs: browserMetrics.app?.lastSearchMs,
    animationFrameCadenceP95Ms: Number(p95.toFixed(2)),
    animationFrameCadenceMaxMs: Number(Math.max(...frameIntervals).toFixed(2)),
    streamFrameWorkMaxMs: browserMetrics.app?.maxFrameWorkMs,
    ...browserMetrics,
  },
};
await writeFile(new URL("performance.json", artifactDir), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.browser, null, 2));
