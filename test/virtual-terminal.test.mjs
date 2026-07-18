import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  AssistantMessageComponent,
  CustomMessageComponent,
  getMarkdownTheme,
  initTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  CURSOR_MARKER,
  Text,
  TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { DASH_DEFAULT_LIMITS } from "../dist/dashboard-contract.js";
import {
  DEFAULT_VIRTUAL_TERMINAL_LIMITS,
  VirtualTerminal,
} from "../dist/virtual-terminal.js";

const pinnedPiRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));

function viewportText(frame) {
  const rows = Array.from({ length: frame.rows }, () => "");
  for (const delta of frame.changedRows) rows[delta.row] = delta.text;
  return rows.join("\n");
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

function initPinnedTheme() {
  const previous = process.env.PI_PACKAGE_DIR;
  process.env.PI_PACKAGE_DIR = pinnedPiRoot;
  try {
    initTheme(undefined, false);
  } finally {
    if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
    else process.env.PI_PACKAGE_DIR = previous;
  }
}

test("VirtualTerminal hard ceilings match the public Dash frame contract", () => {
  assert.equal(DEFAULT_VIRTUAL_TERMINAL_LIMITS.maxColumns, DASH_DEFAULT_LIMITS.maxTuiColumns);
  assert.equal(DEFAULT_VIRTUAL_TERMINAL_LIMITS.maxRows, DASH_DEFAULT_LIMITS.maxTuiRows);
  assert.equal(DEFAULT_VIRTUAL_TERMINAL_LIMITS.maxFrameBytes, DASH_DEFAULT_LIMITS.maxTuiDeltaBytes);
  assert.throws(
    () => new VirtualTerminal(80, 24, { maxRows: DEFAULT_VIRTUAL_TERMINAL_LIMITS.maxRows + 1 }),
    /maxRows/,
  );
  assert.throws(() => new VirtualTerminal(80, 24, { surprise: 1 }), /unknown virtual terminal limit/);
});

test("VirtualTerminal projects ANSI, Unicode, input, resize, cursor, and bounded row deltas", async () => {
  const terminal = new VirtualTerminal(16, 4);
  let input = "";
  let resizeCount = 0;
  terminal.start((data) => {
    input += data;
  }, () => {
    resizeCount += 1;
  });

  terminal.setTitle("Pi\u0000 shadow");
  terminal.setProgress(true);
  terminal.write("\u001b[1;38;2;129;161;193mNord\u001b[0m 界e\u0301");
  terminal.showCursor();
  terminal.sendInput("x\u001b[A");

  const first = terminal.takeFrame();
  assert.equal(first.full, true);
  assert.equal(first.title, "Pi shadow");
  assert.equal(first.progress, true);
  assert.deepEqual(first.cursor, { row: 0, column: 8, visible: true });
  assert.equal(first.changedRows[0].text, "Nord 界é");
  assert.equal(visibleWidth(first.changedRows[0].text), 8);
  assert.deepEqual(first.changedRows[0].runs[0], {
    text: "Nord",
    columns: 4,
    style: {
      foreground: { mode: "rgb", red: 129, green: 161, blue: 193 },
      bold: true,
    },
  });
  assert.equal(input, "x\u001b[A");

  terminal.write("\r\u001b[2K\u001b[32mDone\u001b[0m");
  const delta = terminal.takeFrame();
  assert.equal(delta.full, false);
  assert.deepEqual(delta.changedRows.map((row) => row.row), [0]);
  assert.equal(delta.changedRows[0].text, "Done");
  assert.deepEqual(delta.changedRows[0].runs[0].style.foreground, { mode: "indexed", value: 2 });

  terminal.resize(20, 5);
  assert.equal(resizeCount, 1);
  const resized = terminal.takeFrame();
  assert.equal(resized.full, true);
  assert.equal(resized.changedRows.length, 5);
  assert.throws(() => terminal.resize(DEFAULT_VIRTUAL_TERMINAL_LIMITS.maxColumns + 1, 1), /columns/);
  assert.throws(
    () => terminal.write("x".repeat(DEFAULT_VIRTUAL_TERMINAL_LIMITS.maxWriteBytes + 1)),
    /terminal write exceeds/,
  );
  terminal.stop();
  await terminal.drainInput();
  assert.throws(() => terminal.sendInput("late"), /not started/);
});

test("VirtualTerminal preserves viewport scrolling and erases complete wide cells", () => {
  const terminal = new VirtualTerminal(6, 2);
  terminal.write("first\r\nsecond");
  let frame = terminal.takeFrame();
  assert.deepEqual(frame.changedRows.map((row) => row.text), ["first", "second"]);
  terminal.write("\r\nthird");
  frame = terminal.takeFrame();
  assert.deepEqual(frame.changedRows.map((row) => row.text), ["second", "third"]);

  terminal.clearScreen();
  terminal.write("界");
  terminal.write("\u001b[2GX");
  frame = terminal.takeFrame();
  assert.equal(frame.changedRows[0].text, " X");
  assert.equal(visibleWidth(frame.changedRows[0].text), 2);
});

test("VirtualTerminal strips clipboard, image, device, unsafe link, and unsupported control channels", () => {
  const terminal = new VirtualTerminal(80, 8);
  terminal.write("safe");
  terminal.write("\u001b]52;c;c2VjcmV0\u0007");
  terminal.write("\u001b_Gf=100,a=T;AAAA\u001b\\");
  terminal.write("\u001bP$qm\u001b\\");
  terminal.write("\u001b(0");
  terminal.write("\u001b]1337;File=name=x:AAAA\u0007");
  terminal.write("\u001b]8;;file:///private/secret\u0007bad-link\u001b]8;;\u0007");
  terminal.write("\u001b]8;;https://example.test/path\u0007good\u001b]8;;\u0007");
  terminal.write("\u001b[?9999h\u0001after");

  const frame = terminal.takeFrame();
  assert.equal(frame.changedRows[0].text, "safebad-linkgoodafter");
  assert.equal(frame.stripped.osc52, 1);
  assert.equal(frame.stripped.kittyGraphics, 1);
  assert.equal(frame.stripped.deviceControl, 2);
  assert.equal(frame.stripped.oscOther, 2);
  assert.equal(frame.stripped.unsupportedCsi, 1);
  assert.equal(frame.stripped.controlCharacters, 1);
  const linkRun = frame.changedRows[0].runs.find((run) => run.text === "good");
  assert.equal(linkRun.style.href, "https://example.test/path");
  assert.equal(JSON.stringify(frame).includes("secret"), false);
  assert.equal(JSON.stringify(frame).includes("AAAA"), false);
  assert.equal(JSON.stringify(frame).includes("private/secret"), false);
});

test("VirtualTerminal bounds fragmented escape sequences and frame output", () => {
  const terminal = new VirtualTerminal(8, 2, { maxEscapeBytes: 16, maxFrameBytes: 1024 });
  terminal.write("ok\u001b]52;");
  assert.throws(() => terminal.takeFrame(), /incomplete terminal escape/);
  terminal.write("x\u0007");
  const frame = terminal.takeFrame();
  assert.equal(frame.changedRows[0].text, "ok");
  assert.equal(frame.stripped.osc52, 1);

  const bounded = new VirtualTerminal(8, 2, { maxEscapeBytes: 4 });
  assert.throws(() => bounded.write("\u001b]52;payload-without-terminator"), /escape sequence exceeds/);
  const boundedComplete = new VirtualTerminal(8, 2, { maxEscapeBytes: 8 });
  assert.throws(() => boundedComplete.write("\u001b]52;c;payload\u0007"), /escape sequence exceeds/);

  const tinyFrame = new VirtualTerminal(8, 2, { maxFrameBytes: 32 });
  tinyFrame.write("content");
  assert.throws(() => tinyFrame.takeFrame(), /terminal frame exceeds/);
});

test("exported Pi components render through one in-process TUI and preserve extension input", async () => {
  initPinnedTheme();
  const terminal = new VirtualTerminal(88, 64);
  const tui = new TUI(terminal, true);
  tui.setClearOnShrink(false);
  const content = new Container();
  const markdownTheme = getMarkdownTheme();

  content.addChild(new UserMessageComponent("Please **inspect** `src/index.ts`.", markdownTheme, 1));
  content.addChild(new AssistantMessageComponent({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I should inspect the public exports." },
      { type: "text", text: "I found the exported surface and will update it safely." },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fixture",
    usage: {
      input: 12,
      output: 8,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  }, false, markdownTheme, "Thinking", 1));

  const tool = new ToolExecutionComponent(
    "read",
    "tool-fixture",
    { path: "src/index.ts" },
    { showImages: false, imageWidthCells: 40 },
    undefined,
    tui,
    process.cwd(),
  );
  tool.markExecutionStarted();
  tool.setArgsComplete();
  tool.updateResult({
    content: [{ type: "text", text: "export * from \"./virtual-terminal.js\";" }],
    details: {},
    isError: false,
  });
  content.addChild(tool);
  content.addChild(new CustomMessageComponent({
    role: "custom",
    customType: "fixture:notice",
    content: "Extension state is rendered by the same extension instance.",
    display: true,
    timestamp: Date.now(),
  }, undefined, markdownTheme));

  let editorText = "draft";
  const editor = {
    focused: false,
    render(width) {
      return [(`> ${editorText}${this.focused ? CURSOR_MARKER : ""}`).slice(0, width)];
    },
    handleInput(data) {
      editorText += data;
      tui.requestRender();
    },
    invalidate() {},
  };
  content.addChild(editor);
  tui.addChild(content);
  tui.setFocus(editor);
  tui.showOverlay(new Text("Extension overlay", 1, 0), {
    anchor: "top-right",
    width: 24,
    margin: 1,
    nonCapturing: true,
  });
  tui.start();
  tui.requestRender(true);
  await nextTurn();

  const initial = terminal.takeFrame();
  const text = viewportText(initial);
  assert.match(text, /Please inspect/);
  assert.match(text, /exported surface/);
  assert.match(text, /src\/index\.ts/);
  assert.match(text, /fixture:notice/);
  assert.match(text, /Extension overlay/);
  assert.equal(initial.cursor.visible, true);

  terminal.sendInput("!");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const inputDelta = terminal.takeFrame();
  assert.equal(inputDelta.full, false);
  assert.ok(inputDelta.changedRows.length < inputDelta.rows);
  assert.match(viewportText(inputDelta), /draft!/);
  tui.stop();
});

test("pinned InteractiveMode audit records the unsupported process and extension binding seam", async () => {
  const source = await readFile(
    join(pinnedPiRoot, "dist/modes/interactive/interactive-mode.js"),
    "utf8",
  );
  const session = await readFile(join(pinnedPiRoot, "dist/core/agent-session.js"), "utf8");
  assert.match(source, /new TUI\(new ProcessTerminal\(\)/);
  assert.match(source, /ensureTool\("fd"\)/);
  assert.match(source, /process\.exit\(/);
  assert.match(source, /await this\.session\.bindExtensions\(/);
  assert.match(session, /async bindExtensions\(bindings\)/);
  assert.match(session, /await this\._extensionRunner\.emit\(this\._sessionStartEvent\)/);
  assert.doesNotMatch(source, /class InteractiveSessionView/);
});

test("representative Pi TUI full and delta frame work stays within Dash budgets", async (t) => {
  const terminal = new VirtualTerminal(100, 40);
  const tui = new TUI(terminal);
  tui.setClearOnShrink(false);
  const status = new Text("stream 0000 — responsive", 1, 0);
  const transcript = new Container();
  for (let index = 0; index < 24; index += 1) {
    transcript.addChild(new Text(`row ${String(index).padStart(2, "0")} · Unicode 世界 · ${"x".repeat(48)}`, 1, 0));
  }
  transcript.addChild(status);
  tui.addChild(transcript);
  tui.start();
  tui.requestRender(true);
  await nextTurn();
  terminal.takeFrame();

  const frameWork = [];
  const endToEnd = [];
  let maximumChangedRows = 0;
  for (let index = 1; index <= 80; index += 1) {
    status.setText(`stream ${String(index).padStart(4, "0")} — responsive`);
    const start = performance.now();
    // This invokes the exact pinned pi-tui differential renderer; it is private
    // upstream only because no supported headless view seam exists yet.
    tui.doRender();
    const rendered = performance.now();
    const frame = terminal.takeFrame();
    const completed = performance.now();
    frameWork.push(completed - rendered);
    endToEnd.push(completed - start);
    maximumChangedRows = Math.max(maximumChangedRows, frame.changedRows.length);
  }

  const frameP95 = percentile(frameWork, 0.95);
  const deltaP95 = percentile(endToEnd, 0.95);
  assert.ok(frameP95 < 16, `headless frame p95 ${frameP95.toFixed(2)}ms must stay below 16ms`);
  assert.ok(deltaP95 < 50, `TUI delta p95 ${deltaP95.toFixed(2)}ms must stay below 50ms`);
  assert.ok(maximumChangedRows <= 1, `incremental updates changed ${maximumChangedRows} rows`);

  const resizeDurations = [];
  for (let index = 0; index < 20; index += 1) {
    const width = index % 2 === 0 ? 92 : 116;
    const start = performance.now();
    terminal.resize(width, 40);
    tui.doRender();
    terminal.takeFrame();
    resizeDurations.push(performance.now() - start);
  }
  const resizeP95 = percentile(resizeDurations, 0.95);
  t.diagnostic(
    `shadow TUI p95: frame=${frameP95.toFixed(2)}ms, delta=${deltaP95.toFixed(2)}ms, resize=${resizeP95.toFixed(2)}ms`,
  );
  assert.ok(resizeP95 < 50, `rapid resize p95 ${resizeP95.toFixed(2)}ms must stay below 50ms`);
  tui.stop();
});
