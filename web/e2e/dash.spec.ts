import { expect, test } from "@playwright/test";
import { DASH_API_VERSION, DASH_DEFAULT_LIMITS, DASH_PERFORMANCE_BUDGETS, DASH_STREAM_SUBPROTOCOL } from "../../src/dashboard-contract";

test("renders a bounded Nord Midnight workspace from 10k fixtures", async ({ page }) => {
  await page.goto("./?fixture=1");
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

test("virtual session tree preserves active-leaf truth, filters, compares, and prefills edit-resubmit", async ({ page }) => {
  await page.goto("./?fixture=1&state=ready");
  const pane = page.locator(".workspace-pane--selected");
  await pane.getByRole("button", { name: "Open session branch tree" }).click();
  const navigator = pane.getByRole("complementary", { name: "Session branch tree" });
  await expect(navigator).toBeVisible();
  const tree = navigator.getByRole("tree", { name: "Versioned conversation branches" });
  await expect(tree).toBeVisible();
  await expect(tree.getByRole("treeitem")).toHaveCount(5);
  await expect(tree.locator('[role="treeitem"][aria-current="true"]')).toContainText("github-copilot/gpt-5.6");
  await tree.focus();
  await page.keyboard.press("Home");
  await expect(tree.getByRole("treeitem", { selected: true })).toContainText("Start the implementation");
  await page.keyboard.press("ArrowRight");
  await expect(tree.getByRole("treeitem", { selected: true })).toContainText("experiment");

  await navigator.getByPlaceholder("Filter label, type, or text").fill("experiment");
  await expect(tree.getByRole("treeitem")).toHaveCount(3);
  await tree.getByRole("treeitem", { name: /^experiment / }).click();
  await navigator.getByRole("button", { name: "Compare with active" }).click();
  await expect(navigator.getByRole("region", { name: "Side-by-side branch comparison" })).toContainText("tree-root");
  await navigator.getByRole("button", { name: /Edit & resubmit/ }).click();
  await navigator.getByRole("button", { name: "Close session tree" }).click();
  await expect(pane.getByTestId("composer-editor")).toContainText("Try the abandoned approach");

  await pane.getByRole("button", { name: "Open session branch tree" }).click();
  await navigator.getByPlaceholder("Filter label, type, or text").fill("experiment");
  await tree.getByRole("treeitem", { name: /^experiment / }).click();
  await navigator.getByRole("button", { name: "Summarize & navigate" }).click();
  await navigator.getByLabel("Summary label").fill("abandoned-review");
  await navigator.getByLabel("Summary instructions").fill("Summarize the abandoned experiment");
  await navigator.getByRole("button", { name: "Summarize abandoned branch" }).click();
  await expect(navigator.locator(".session-tree__state")).toHaveCount(0);
});

test("10k branch tree remains virtualized without an O(total entries) DOM", async ({ page }) => {
  await page.goto("./?fixture=1&state=ready&tree=large");
  const pane = page.locator(".workspace-pane--selected");
  const startedAt = performance.now();
  await pane.getByRole("button", { name: "Open session branch tree" }).click();
  const navigator = pane.getByRole("complementary", { name: "Session branch tree" });
  await expect(navigator.getByRole("heading", { name: /10,000 entries/ })).toBeVisible();
  const elapsed = performance.now() - startedAt;
  expect(elapsed).toBeLessThan(3_000);
  const rendered = await navigator.getByRole("treeitem").count();
  expect(rendered).toBeGreaterThan(5);
  expect(rendered).toBeLessThan(60);
});

test("search, deliberate states, settings, and directional swaps remain interactive", async ({ page }) => {
  await page.goto("./?fixture=1&state=ready");
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
  await page.goto("./?fixture=1&state=ready");
  await page.locator("[data-session-row]").first().waitFor();
  await page.getByText("Browse by state and source").click();
  await expect(page.getByRole("button", { name: /Scheduled/ })).toHaveCount(0);
  await page.getByRole("button", { name: /Running/ }).first().click();
  await expect(page.getByRole("img", { name: "Running" }).first()).toBeVisible();

  const info = page.getByRole("button", { name: /Open information for/ }).first();
  await info.focus();
  await expect(page.getByRole("tooltip")).toContainText("Working dir");
  await expect(page.getByRole("tooltip")).toContainText("Open the information view");
  await info.click();
  await expect(page.getByText("Session information").first()).toBeVisible();
});

test("capability-gated schedule editor renders validation, history, disabled and unseen states", async ({ page }) => {
  await page.goto("./?fixture=1&state=ready&schedules=1");
  await expect(page.getByRole("heading", { name: "Schedules" })).toBeVisible();
  await expect(page.getByText("Weekdays at 09:00")).toBeVisible();
  await expect(page.getByText("completed", { exact: true })).toBeVisible();
  const prompt = page.getByLabel("Prompt");
  await expect(prompt).toHaveValue("");
  await expect(prompt).toHaveAttribute("placeholder", /Prompt configured/);
  await page.getByRole("button", { name: "Disable" }).click();
  await expect(page.locator(".schedule-summary-card")).toHaveAttribute("data-state", "disabled");
  await page.getByLabel("Cron expression").fill("99 25 * * *");
  await expect(page.getByText(/outside its allowed range/)).toBeVisible();
  await page.getByTestId("session-search").fill("session-00153");
  const unseenScheduled = page.locator(".presence-dot--scheduled.presence-dot--unread");
  await expect(unseenScheduled).toBeVisible();
  await expect(page.locator(".session-row__countdown")).toBeVisible();
});

test("sidebar loading, error recovery, and mobile drawer states are explicit", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 820 });
  await page.goto("./?fixture=1&sidebar=error&state=ready");
  await expect(page.locator(".sidebar-list-state--error")).toContainText("Session index unavailable");
  await page.getByRole("button", { name: "Retry inventory" }).click();
  await page.locator("[data-session-row]").first().waitFor();

  const app = page.locator(".dash-app");
  await expect(app).toHaveAttribute("data-sidebar-open", "true");
  await page.getByRole("button", { name: "Close session drawer" }).first().click();
  await expect(app).toHaveAttribute("data-sidebar-open", "false");
  await page.getByRole("button", { name: "Open session drawer" }).click();
  await expect(app).toHaveAttribute("data-sidebar-open", "true");

  await page.goto("./?fixture=1&sidebar=loading&state=ready");
  await expect(page.getByLabel("Loading sessions")).toHaveAttribute("aria-busy", "true");
});

test("rich transcript renders semantic markdown, tools, images, summaries, custom and error states", async ({ page }) => {
  await page.goto("./?fixture=1&state=ready");
  await expect(page.getByRole("heading", { name: "Generation-safe reducer" })).toBeVisible();
  await expect(page.locator(".syntax-block").first()).toBeVisible();
  await expect(page.locator("script[data-unsafe]")).toHaveCount(0);
  await expect(page.getByText("<script data-unsafe>window.__dashUnsafe = true</script>", { exact: true })).toBeVisible();
  await expect(page.locator(".message-image--placeholder")).toContainText("Nord Midnight dashboard reference");
  await expect(page.locator(".summary-card")).toContainText("Context compacted");
  await expect(page.locator(".custom-record").filter({ hasText: "safe generic renderer" })).toBeVisible();
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
  await page.goto("./?fixture=1&state=ready");
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
  await page.goto("./?fixture=1&state=ready");
  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.locator(".settings-dialog");
  await expect(settings).toBeVisible();
  await settings.getByRole("radio", { name: /Nord Frost/ }).click();
  await expect(page.locator(".dash-app")).toHaveAttribute("data-theme", "nord-frost");
  await expect(settings.getByText("runtime", { exact: true }).first()).toBeVisible();
  await settings.getByRole("button", { name: "compact" }).click();
  await expect(page.locator(".dash-app")).toHaveAttribute("data-density", "compact");
  await settings.getByRole("switch", { name: "Reduce motion" }).click();
  await expect(page.locator(".dash-app")).toHaveAttribute("data-reduced-motion", "true");

  await settings.getByRole("tab", { name: "Editor & keys" }).click();
  await expect(settings.getByRole("tabpanel")).toContainText("Keyboard behavior");
  await settings.getByRole("switch", { name: "Vim composer" }).click();
  await settings.getByRole("tab", { name: "Transcript" }).click();
  await expect(settings.getByRole("tabpanel")).toContainText("Expand tool calls");
  await settings.getByRole("switch", { name: "Expand tool calls" }).click();
  await settings.getByRole("tab", { name: "Cache & limits" }).click();
  await expect(settings.getByRole("spinbutton", { name: "Transcript cache entries" })).toHaveValue("64");

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

test("new session draft persists, cancels safely, and transitions one first send into live chat", async ({ page }) => {
  await page.goto("./?fixture=1&state=ready");
  await page.getByRole("button", { name: "Create new session draft" }).click();
  const pane = page.locator(".workspace-pane--selected");
  await expect(pane.getByRole("heading", { name: "An empty conversation" })).toBeVisible();
  await expect(pane.locator(".composer-status")).toContainText("No network or runtime work has started");
  await expect(pane.getByLabel("Working directory")).toHaveValue("/home/fixture");
  await expect(pane.getByLabel(/Provider/)).toHaveValue("github-copilot");
  await expect(pane.getByLabel("Model ID")).toHaveValue("gpt-5.6-sol");
  await expect(pane.getByLabel("Thinking")).toHaveValue("high");
  await expect(pane.getByLabel("Tool policy")).toHaveValue("default");
  await pane.getByText("Resources and trust policy").click();
  await expect(pane.getByLabel("Project trust")).toHaveValue("approve");
  await expect(pane.getByLabel("Effective new session defaults")).toContainText("model · pi-settings");
  await expect(pane.getByLabel("Effective new session defaults")).toContainText("authority · runtime-policy");
  await pane.getByRole("button", { name: "Cancel new session draft" }).click();
  await expect(pane.getByRole("heading", { name: "Choose a session" })).toBeVisible();

  await page.getByRole("button", { name: "Create new session draft" }).click();
  await pane.getByLabel("Working directory").fill("/tmp/pi-daemon-dash-test");
  await pane.getByLabel("Session name optional").fill("Fresh browser session");
  await pane.getByRole("button", { name: "Save draft" }).click();
  await expect(pane).toHaveAttribute("data-pane-content", /chat:draft:/);
  await expect(pane.locator(".composer-status")).toContainText("Draft saved");
  const editor = pane.getByTestId("composer-editor");
  await editor.click();
  await page.keyboard.type("first message starts once");
  await pane.getByRole("button", { name: "Start session" }).click();
  await expect(pane.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(pane.locator(".live-session-strip")).toContainText(/live|streaming/);
  await expect(pane.locator('[data-record-source="optimistic"]')).toHaveCount(0);
});

test("activating an old direct-coopt session refreshes activity order without rewriting source modified time", async ({ page }) => {
  await page.goto("./?fixture=1&state=ready");
  const search = page.getByTestId("session-search");
  await search.fill("session-09999");
  const oldRow = page.locator("[data-session-row]").first();
  await expect(oldRow).toContainText("09999");
  await oldRow.click();
  const pane = page.locator(".workspace-pane--selected");
  await expect(pane.locator(".composer-status")).toContainText("First send will safe fork");
  await pane.getByRole("button", { name: "Direct co-opt" }).click();
  const editor = pane.getByTestId("composer-editor");
  await editor.click();
  await page.keyboard.type("activate old direct session");
  await pane.getByRole("button", { name: "Activate & send" }).click();
  await expect(pane.getByRole("button", { name: "Send message" })).toBeVisible();
  await search.fill("");
  await expect(page.locator("[data-session-row]").first()).toContainText("09999");
  await page.locator("[data-session-row]").first().getByRole("button", { name: /Open information for/ }).click();
  const selectedInfo = page.locator(".workspace-pane--selected");
  await expect(selectedInfo.getByText("Last active", { exact: true })).toBeVisible();
  await expect(selectedInfo.getByText("Source modified", { exact: true })).toBeVisible();
});

test("dormant preview stays scrollable and wakes on first composer send", async ({ page }) => {
  await page.goto("./?fixture=1&state=ready");
  await page.getByTestId("session-search").fill("session-00001");
  await page.locator("[data-session-row]").first().click();
  const pane = page.locator(".workspace-pane--selected");
  const transcript = pane.locator(".transcript");
  const footer = pane.locator(".chat-pane__footer");
  await expect(pane.locator(".live-state-card")).toHaveCount(0);
  await expect(transcript).toBeVisible();
  await expect(footer).toBeVisible();
  await expect(pane.locator(".composer-status")).toContainText(
    "First send will reuse managed session, hydrate, and wake this session",
  );
  const scrollable = await transcript.evaluate((element) => {
    element.scrollTop = Math.max(1, element.scrollHeight - element.clientHeight);
    return element.scrollHeight > element.clientHeight && element.scrollTop > 0;
  });
  expect(scrollable).toBe(true);
  const [paneBox, transcriptBox, footerBox] = await Promise.all([
    pane.boundingBox(),
    transcript.boundingBox(),
    footer.boundingBox(),
  ]);
  expect(paneBox).not.toBeNull();
  expect(transcriptBox).not.toBeNull();
  expect(footerBox).not.toBeNull();
  if (paneBox && transcriptBox && footerBox) {
    expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(paneBox.y + paneBox.height + 1);
    expect(transcriptBox.y + transcriptBox.height).toBeLessThanOrEqual(footerBox.y + 1);
  }

  const editor = pane.getByTestId("composer-editor");
  await editor.click();
  await page.keyboard.type("wake from preview");
  await pane.getByRole("button", { name: "Activate & send" }).click();
  await expect(pane.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(pane.locator(".live-session-strip")).toContainText(/live|streaming/);
});

test("single full-width chat keeps transcript scrollable and composer pinned", async ({ page }) => {
  await page.goto("./?fixture=1&state=ready");
  const inspector = page.locator('[data-pane-content^="info:"]');
  await inspector.click({ position: { x: 12, y: 120 } });
  await inspector.getByRole("button", { name: "Close pane" }).click({ force: true });

  const pane = page.locator(".workspace-pane");
  await expect(pane).toHaveCount(1);
  const transcript = pane.locator(".transcript");
  const footer = pane.locator(".chat-pane__footer");
  await expect(transcript).toBeVisible();
  await expect(footer).toBeVisible();
  const geometry = await pane.evaluate((element) => {
    const transcriptElement = element.querySelector<HTMLElement>(".transcript");
    const footerElement = element.querySelector<HTMLElement>(".chat-pane__footer");
    if (!transcriptElement || !footerElement) return undefined;
    transcriptElement.scrollTop = transcriptElement.scrollHeight;
    return {
      paneBottom: element.getBoundingClientRect().bottom,
      transcriptBottom: transcriptElement.getBoundingClientRect().bottom,
      footerBottom: footerElement.getBoundingClientRect().bottom,
      scrollHeight: transcriptElement.scrollHeight,
      clientHeight: transcriptElement.clientHeight,
      scrollTop: transcriptElement.scrollTop,
    };
  });
  expect(geometry).toBeDefined();
  expect(geometry!.scrollHeight).toBeGreaterThan(geometry!.clientHeight);
  expect(geometry!.scrollTop).toBeGreaterThan(0);
  expect(geometry!.footerBottom).toBeLessThanOrEqual(geometry!.paneBottom + 1);
  expect(geometry!.transcriptBottom).toBeLessThanOrEqual(geometry!.footerBottom + 1);

  const editor = pane.getByTestId("composer-editor");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.insertText("full pane remains interactive");
  await expect(editor).toContainText("full pane remains interactive");
});

test("left-right split and divider resize reflow each chat to its own width", async ({ page }) => {
  await page.goto("./?fixture=1&state=ready");
  const inspector = page.locator('[data-pane-content^="info:"]');
  await inspector.click({ position: { x: 12, y: 120 } });
  await inspector.getByRole("button", { name: "Close pane" }).click({ force: true });
  const primary = page.locator('[data-pane-id="primary"]');
  await primary.getByRole("button", { name: "Split pane horizontally" }).click({ force: true });
  await page.locator(".session-row").first().click();
  await expect(page.locator(".chat-pane")).toHaveCount(2);

  async function assertPaneWidths(): Promise<number[]> {
    return page.locator(".workspace-pane").evaluateAll((panes) => panes.map((pane) => {
      const chat = pane.querySelector<HTMLElement>(".chat-pane");
      const transcript = pane.querySelector<HTMLElement>(".transcript");
      const sizer = pane.querySelector<HTMLElement>(".transcript__sizer");
      if (!chat || !transcript || !sizer) throw new Error("chat geometry missing");
      const paneWidth = pane.getBoundingClientRect().width;
      const chatWidth = chat.getBoundingClientRect().width;
      const transcriptWidth = transcript.getBoundingClientRect().width;
      const sizerWidth = sizer.getBoundingClientRect().width;
      if (Math.abs(chatWidth - paneWidth) > 2 || transcriptWidth > chatWidth + 1 || sizerWidth > transcriptWidth + 1) {
        throw new Error(`clipped pane ${paneWidth}/${chatWidth}/${transcriptWidth}/${sizerWidth}`);
      }
      return paneWidth;
    }));
  }

  const before = await assertPaneWidths();
  const separator = page.getByRole("separator", { name: "Resize horizontal split" });
  const box = await separator.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 140, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
  }
  await expect.poll(async () => (await assertPaneWidths())[0]).not.toBe(before[0]);
  const after = await assertPaneWidths();
  expect(Math.abs(after[0]! - before[0]!)).toBeGreaterThan(80);
});

test("composer completion and bounded history work outside Vim mode", async ({ page }) => {
  await page.goto("./?fixture=1&state=ready");
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
  await page.goto("./?fixture=1&state=ready");
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
  const restoredScrollTop = await primary.locator(".transcript").evaluate((element) => element.scrollTop);
  expect(Math.abs(restoredScrollTop - richScrollTop)).toBeLessThan(200);
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

test("production boot uses same-origin login and never paints fixture data", async ({ page }) => {
  let authenticated = false;
  const now = "2026-07-19T00:00:00.000Z";
  const identity = {
    dashVersion: DASH_API_VERSION,
    requestId: "request-browser-test",
    serverInstanceId: "dash-browser-test",
    clientId: "client-browser-test",
    workspaceId: "workspace-browser-test",
  } as const;
  const inventory = { sessions: [], index: { formatVersion: 1, loadedAt: now, stale: false, reconciling: false } } as const;
  const settings = {
    revision: 1,
    effective: {
      theme: { name: "nord-midnight", density: "comfortable" },
      editor: { mode: "multiline" },
      sidebar: { initialLimit: 100, showProject: true, groupBy: "none" },
      transcript: { expandTools: false, expandThinking: false },
      motion: { reduced: false },
      cache: { transcriptBytes: 1024, transcriptEntries: 8 },
    },
    runtimeOverlay: {},
    sources: {},
  } as const;
  const workspace = {
    workspaceId: identity.workspaceId,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    selectedPaneId: "primary",
    layout: { type: "leaf", paneId: "primary", content: { type: "empty" } },
    seenCursors: {},
  } as const;
  const capabilities = {
    apiVersion: DASH_API_VERSION,
    streamSubprotocol: DASH_STREAM_SUBPROTOCOL,
    sameBrowserProtocolAcrossDeployments: true,
    authentication: { browserSession: "http-only-cookie", csrf: "same-origin-header", daemonBearerExposed: false },
    resources: { inventory: true, transcriptPreview: true, activation: true, export: true, workspaces: true, settings: true, schedules: false, sessionDrafts: true },
    presentations: {
      rich: { available: true, replay: true, controller: true, commands: ["prompt"] },
      tui: { available: false, replay: true, controller: true, commands: [], unavailableReason: "test" },
    },
    limits: DASH_DEFAULT_LIMITS,
    performanceBudgets: DASH_PERFORMANCE_BUDGETS,
  } as const;
  await page.route("**/dash/v1/login", async (route) => {
    authenticated = true;
    await route.fulfill({ json: { ...identity, ok: true, data: { clientId: identity.clientId, workspaceId: identity.workspaceId, expiresAt: "2026-07-20T00:00:00.000Z", csrfToken: "csrf-browser-test" } } });
  });
  await page.route("**/dash/v1/bootstrap", async (route) => {
    await route.fulfill(authenticated
      ? { headers: { "x-pi-daemon-csrf": "r".repeat(43) }, json: { ...identity, ok: true, data: { capabilities, settings, workspace, inventory } } }
      : { status: 401, json: { ...identity, clientId: "unauthenticated", workspaceId: "unauthenticated", ok: false, error: { code: "unauthorized", message: "dashboard authentication failed", retryable: false } } });
  });
  await page.route("**/dash/v1/sessions*", async (route) => route.fulfill({ json: { ...identity, ok: true, data: inventory } }));

  await page.goto("./");
  await expect(page.getByRole("heading", { name: "Sign in to Dash" })).toBeVisible();
  await page.getByLabel("Web credential").fill("input-only-test-credential");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dash" })).toBeVisible();
  await expect(page.locator(".workspace-notice")).toContainText("Authenticated");
  await expect(page.getByText("loaded sessions", { exact: true })).toBeVisible();
  await expect(page.getByText("Fixture", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Local fixture", { exact: false })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Dash" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in to Dash" })).toHaveCount(0);
});

test("lazy composer accepts IME-shaped text without triggering pane shortcuts", async ({ page }) => {
  await page.goto("./?fixture=1&state=ready");
  const editor = page.getByTestId("composer-editor");
  await editor.click();
  await page.keyboard.type("設計を静かに磨く");
  await expect(editor).toContainText("設計を静かに磨く");
  await page.keyboard.press("Control+h");
  await expect(page.locator("[data-pane-id=primary]")).toHaveClass(/workspace-pane--selected/);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Completed fixture response to:", { exact: false })).toBeVisible();
  await page.waitForTimeout(650);
  await expect(page.getByText("Completed fixture response to:", { exact: false })).toHaveCount(1);
  const persisted = page.getByText("Completed fixture response to:", { exact: false }).locator("xpath=ancestor::article");
  await expect(persisted.locator(".record-source--persisted")).toBeVisible();
});
