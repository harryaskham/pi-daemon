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
  await expect(page.locator(".state-panel--error")).toContainText("Live channel paused");
  await expect(page.locator(".session-ribbon")).toContainText("Replay gap · reconciliation required");
  await page.getByRole("button", { name: "ready" }).click();
  await expect(page.locator(".session-ribbon")).toContainText("Preview ready · hydration not requested");

  const before = await page.locator("[data-pane-id=primary]").getAttribute("data-pane-content");
  await page.locator("[data-pane-id=primary]").focus();
  await page.keyboard.press("Control+Shift+l");
  const after = await page.locator("[data-pane-id=inspector]").getAttribute("data-pane-content");
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
  await expect(page.locator(".sidebar-list-state--error")).toContainText("Session index unavailable");
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

test("rich transcript renders semantic markdown, tools, images, summaries, custom and error states", async ({ page }) => {
  await page.goto("./?state=ready");
  await expect(page.getByRole("heading", { name: "Generation-safe reducer" })).toBeVisible();
  await expect(page.locator(".syntax-block").first()).toBeVisible();
  await expect(page.locator("script[data-unsafe]")).toHaveCount(0);
  await expect(page.getByText("<script data-unsafe>window.__dashUnsafe = true</script>", { exact: true })).toBeVisible();
  await expect(page.locator(".message-image--placeholder")).toContainText("Nord Midnight dashboard reference");
  await expect(page.locator(".summary-card")).toContainText("Context compacted");
  await expect(page.locator(".custom-record")).toContainText("safe generic renderer");
  await expect(page.locator(".timeline-record--queue")).toContainText("Follow-up queued");
  await expect(page.locator(".message-error")).toContainText("replay gap");
  await expect(page.locator(".tool-card--bash")).toContainText("bounded stream still running");
  const customDetails = page.getByRole("button", { name: "Show details for Render extension status" });
  await customDetails.click();
  await expect(page.locator(".generic-tool-output")).toContainText("without executing browser-side extension code");

  const editDetails = page.getByRole("button", { name: "Show details for Edit web/src/transcript-store.ts" });
  await editDetails.click();
  await expect(page.locator(".diff-line--add").first()).toContainText("transcriptRecordIdentity");
  await expect(page.getByRole("button", { name: "Hide details for Edit web/src/transcript-store.ts" })).toHaveAttribute("aria-expanded", "true");
});

test("split creation, keyboard resize, close promotion, and revision persistence stay coherent", async ({ page }) => {
  await page.goto("./?state=ready");
  const panes = page.locator("[data-pane-id]");
  await expect(panes).toHaveCount(2);
  const workspaceRevision = async () => {
    const text = await page.locator(".workspace-notice").textContent();
    return Number(/workspace r(\d+)/.exec(text ?? "")?.[1] ?? 0);
  };
  await page.locator('[data-pane-id="primary"]').getByRole("button", { name: "Split pane vertically" }).click();
  await expect(panes).toHaveCount(3);
  await page.locator(".session-row").first().click();
  await expect(page.locator('[data-session-store="session-00000:1"]')).toHaveCount(2);
  await expect.poll(workspaceRevision).toBeGreaterThan(1);
  const splitRevision = await workspaceRevision();

  const verticalSeparator = page.getByRole("separator", { name: "Resize vertical split" });
  const box = await verticalSeparator.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 42, { steps: 4 });
    await page.mouse.up();
  }
  const before = Number(await verticalSeparator.getAttribute("aria-valuenow"));
  expect(before).not.toBe(50);
  await verticalSeparator.focus();
  await page.keyboard.press("ArrowDown");
  await expect(verticalSeparator).toHaveAttribute("aria-valuenow", String(before + 3));
  await expect.poll(workspaceRevision).toBeGreaterThan(splitRevision);
  const resizeRevision = await workspaceRevision();

  const selected = page.locator(".workspace-pane--selected");
  await selected.getByRole("button", { name: "Close pane" }).click();
  await expect(panes).toHaveCount(2);
  await expect.poll(workspaceRevision).toBeGreaterThan(resizeRevision);
});

test("settings hot-switch, source reporting, reset, and keyboard guide are revisioned", async ({ page }) => {
  await page.goto("./?state=ready");
  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.locator(".settings-dialog");
  await expect(settings).toBeVisible();
  await settings.getByRole("radio", { name: /Nord Frost/ }).click();
  await expect(page.locator(".dash-app")).toHaveAttribute("data-theme", "nord-frost");
  await expect(settings.getByText("runtime", { exact: true }).first()).toBeVisible();
  await settings.getByRole("button", { name: "compact" }).click();
  await expect(page.locator(".dash-app")).toHaveAttribute("data-density", "compact");
  await settings.getByRole("switch", { name: "Vim composer" }).click();
  await settings.getByRole("switch", { name: "Reduce motion" }).click();
  await expect(page.locator(".dash-app")).toHaveAttribute("data-reduced-motion", "true");
  await settings.getByRole("button", { name: "Revert to configured defaults" }).click();
  await expect(page.locator(".dash-app")).toHaveAttribute("data-theme", "nord-midnight");
  await expect(page.locator(".dash-app")).toHaveAttribute("data-density", "comfortable");
  await settings.getByRole("button", { name: "Done" }).click();

  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard guide" });
  await expect(help).toContainText("Ctrl-Shift-h / j / k / l");
  await expect(help).toContainText("Alt-Up / Alt-Down");
  await help.getByRole("button", { name: "Done" }).click();
});

test("composer completion and bounded history work outside Vim mode", async ({ page }) => {
  await page.goto("./?state=ready");
  await page.getByRole("button", { name: /VIM · INSERT/ }).click();
  const editor = page.getByTestId("composer-editor");
  await editor.click();
  await page.keyboard.type("/th");
  await expect(page.getByRole("option", { name: "/thinking" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(editor).toContainText("/thinking");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("first history message");
  await page.getByRole("button", { name: "Send message" }).click();
  await editor.click();
  await page.keyboard.type("second history message");
  await page.getByRole("button", { name: "Send message" }).click();
  await editor.click();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(editor).toContainText("second history message");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText("pasted line one\npasted line two");
  await expect(editor).toContainText("pasted line one");
  await expect(editor).toContainText("pasted line two");
});

test("TUI presentation streams one canonical controller grid to read-only pane mirrors", async ({ page }) => {
  await page.goto("./?state=ready");
  const primary = page.locator('[data-pane-id="primary"]');
  const richScroller = primary.locator(".transcript");
  const richScrollTop = await richScroller.evaluate((element) => element.scrollTop);
  await primary.getByRole("button", { name: "Switch to TUI presentation" }).click();
  await expect(primary.locator(".tui-grid")).toHaveAttribute("data-role", "controller");
  await expect(primary.locator(".tui-grid__row").first()).toContainText("Pi Daemon Dash");
  await expect(primary.locator(".tui-grid__role")).toHaveText("Controller");

  const grid = primary.locator(".tui-grid");
  await grid.focus();
  await page.keyboard.press("x");
  await expect(primary.locator(".tui-grid__row").filter({ hasText: "terminal input · key x" })).toHaveCount(1);
  await grid.evaluate((element) => {
    const data = new DataTransfer();
    data.setData("text/plain", "bounded paste");
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await expect(primary.locator(".tui-grid__row").filter({ hasText: "terminal input · paste bounded paste" })).toHaveCount(1);
  await primary.getByRole("button", { name: "Rich" }).click();
  await expect(primary.locator(".transcript")).toBeVisible();
  expect(await primary.locator(".transcript").evaluate((element) => element.scrollTop)).toBe(richScrollTop);
  await primary.getByRole("button", { name: "Switch to TUI presentation" }).click();

  await primary.getByRole("button", { name: "Split pane horizontally" }).click();
  await page.locator(".session-row").first().click();
  const selectedPaneId = await page.locator(".workspace-pane--selected").getAttribute("data-pane-id");
  expect(selectedPaneId).not.toBeNull();
  const secondary = page.locator(`[data-pane-id="${selectedPaneId}"]`);
  await secondary.getByRole("button", { name: "Switch to TUI presentation" }).click();
  await expect(page.locator('[data-tui-session-store="session-00000:1"]')).toHaveCount(2);
  await expect(primary.locator(".tui-grid")).toHaveAttribute("data-role", "observer");
  await expect(secondary.locator(".tui-grid")).toHaveAttribute("data-role", "controller");
  await secondary.locator(".tui-grid").focus();
  await page.keyboard.press("z");
  await expect(page.locator(".tui-grid__row").filter({ hasText: "terminal input · key z" })).toHaveCount(2);

  await page.keyboard.press("Control+h");
  await expect(primary).toHaveClass(/workspace-pane--selected/);
  await expect(primary.locator(".tui-grid")).toHaveAttribute("data-role", "controller");
  await expect(secondary.locator(".tui-grid")).toHaveAttribute("data-role", "observer");
  await primary.getByRole("button", { name: "Rich" }).click();
  await expect(primary.locator(".transcript")).toBeVisible();
});

test("lazy composer accepts IME-shaped text without triggering pane shortcuts", async ({ page }) => {
  await page.goto("./?state=ready");
  const editor = page.getByTestId("composer-editor");
  await editor.click();
  await page.keyboard.type("設計を静かに磨く");
  await expect(editor).toContainText("設計を静かに磨く");
  await page.keyboard.press("Control+h");
  await expect(page.locator("[data-pane-id=primary]")).toHaveClass(/workspace-pane--selected/);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Fixture submission accepted.", { exact: false })).toBeVisible();
  await page.waitForTimeout(650);
  await expect(page.getByText("Fixture submission accepted.", { exact: false })).toHaveCount(1);
  const persisted = page.getByText("Fixture submission accepted.", { exact: false }).locator("xpath=ancestor::article");
  await expect(persisted.locator(".record-source--persisted")).toBeVisible();
});
