import { expect, test } from "@playwright/test";

test("renders a bounded Nord Midnight workspace from 10k fixtures", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "Dash" })).toBeVisible();
  await expect(page.getByLabel("Session summary").getByText("10,000")).toBeVisible();
  await expect(page.locator(".workspace-notice")).toContainText("Preview ready · runtime hydration remains separate");
  await page.locator("[data-session-row]").first().waitFor();
  const firstRowsMs = await page.evaluate(() => window.__DASH_METRICS__?.firstRowsMs);
  expect(firstRowsMs).toBeDefined();
  expect(firstRowsMs ?? Number.POSITIVE_INFINITY).toBeLessThan(150);
  const renderedRows = await page.locator("[data-session-row]").count();
  expect(renderedRows).toBeGreaterThan(2);
  expect(renderedRows).toBeLessThan(40);
  const transcriptRows = await page.locator("[data-transcript-row]").count();
  expect(transcriptRows).toBeGreaterThan(2);
  expect(transcriptRows).toBeLessThan(50);
});

test("search, deliberate states, settings, and directional swaps remain interactive", async ({ page }) => {
  await page.goto("./?state=ready");
  const search = page.getByTestId("session-search");
  await search.fill("session-09999");
  await expect(page.getByText(/09999/)).toBeVisible();
  const searchMs = await page.evaluate(() => window.__DASH_METRICS__?.lastSearchMs);
  expect(searchMs).toBeDefined();
  expect(searchMs ?? Number.POSITIVE_INFINITY).toBeLessThan(100);
  await search.fill("");

  await page.getByRole("button", { name: "empty" }).click();
  await expect(page.getByRole("heading", { name: "A quiet session" })).toBeVisible();
  await page.getByRole("button", { name: "error" }).click();
  await expect(page.getByRole("alert")).toContainText("Live channel paused");

  const before = await page.locator("[data-pane-id=primary]").textContent();
  await page.locator("[data-pane-id=primary]").focus();
  await page.keyboard.press("Control+Shift+l");
  const after = await page.locator("[data-pane-id=inspector]").textContent();
  expect(after).toBe(before);

  await page.keyboard.press("Control+,");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("Nord Midnight", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
});

test("expandable filters and hover/focus information stay accessible", async ({ page }) => {
  await page.goto("./?state=ready");
  await page.locator("[data-session-row]").first().waitFor();
  await page.getByText("Browse by state and source").click();
  await expect(page.getByRole("button", { name: /Scheduled/ })).toBeVisible();
  await page.getByRole("button", { name: /Running/ }).first().click();
  await expect(page.getByRole("img", { name: "Running" }).first()).toBeVisible();

  const info = page.getByRole("button", { name: /Open information for/ }).first();
  await info.focus();
  await expect(page.getByRole("tooltip")).toContainText("Working dir");
  await expect(page.getByRole("tooltip")).toContainText("Open the information view");
  await info.click();
  await expect(page.getByText("Session information").first()).toBeVisible();
});

test("sidebar loading, error recovery, and mobile drawer states are explicit", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 820 });
  await page.goto("./?sidebar=error&state=ready");
  await expect(page.getByRole("alert")).toContainText("Session index unavailable");
  await page.getByRole("button", { name: "Retry inventory" }).click();
  await page.locator("[data-session-row]").first().waitFor();

  const app = page.locator(".dash-app");
  await expect(app).toHaveAttribute("data-sidebar-open", "true");
  await page.getByRole("button", { name: "Close session drawer" }).first().click();
  await expect(app).toHaveAttribute("data-sidebar-open", "false");
  await page.getByRole("button", { name: "Open session drawer" }).click();
  await expect(app).toHaveAttribute("data-sidebar-open", "true");

  await page.goto("./?sidebar=loading&state=ready");
  await expect(page.getByLabel("Loading sessions")).toHaveAttribute("aria-busy", "true");
});

test("lazy composer accepts IME-shaped text without triggering pane shortcuts", async ({ page }) => {
  await page.goto("./?state=ready");
  const editor = page.getByTestId("composer-editor");
  await editor.click();
  await page.keyboard.type("設計を静かに磨く");
  await expect(editor).toContainText("設計を静かに磨く");
  await page.keyboard.press("Control+h");
  await expect(page.locator("[data-pane-id=primary]")).toHaveClass(/workspace-pane--selected/);
});
