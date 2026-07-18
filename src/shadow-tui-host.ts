import { randomUUID } from "node:crypto";

import type {
  DashboardChannelListener,
  DashboardCommandResult,
  DashboardCursor,
  DashboardReplayGap,
  DashboardSessionIdentity,
  DashboardTuiChannel,
  DashboardTuiChannelEvent,
  DashboardTuiDelta,
  DashboardTuiInput,
  DashboardTuiSnapshot,
  TuiChannelOptions,
  TuiDimensions,
  TuiRow,
  TuiStyle,
} from "./dashboard-contract.js";
import { asDashboardCursor, DASH_DEFAULT_LIMITS } from "./dashboard-contract.js";
import type { InProcessDashboardTuiChannels } from "./dashboard-backend.js";
import {
  DEFAULT_VIRTUAL_TERMINAL_LIMITS,
  VirtualTerminal,
  type VirtualTerminalColor,
  type VirtualTerminalFrame,
  type VirtualTerminalStyle,
} from "./virtual-terminal.js";

export interface ShadowInteractiveSessionView {
  readonly extensionUI: unknown;
  init(): Promise<void>;
  requestRender(force?: boolean): void;
  stop(): void;
}

export interface ShadowInteractiveSessionViewFactory<Runtime = unknown> {
  create(
    runtime: Runtime,
    options: {
      host: {
        terminal: VirtualTerminal;
        requestExit(request: { code: number; reason: string }): void;
        resolveAutocompleteTool(name: "fd" | "rg"): Promise<string | undefined>;
      };
      extensionBinding: "external";
    },
  ): ShadowInteractiveSessionView;
}

export interface ShadowTuiExtensionBroker {
  bind(identity: DashboardSessionIdentity, extensionUI: unknown): () => void;
}

export interface ShadowTuiHostLimits {
  maxViews: number;
  maxChannelsPerView: number;
  maxReplayEvents: number;
  maxReplayBytes: number;
  maxFrameBytes: number;
  maxPasteBytes: number;
}

export const DEFAULT_SHADOW_TUI_HOST_LIMITS: Readonly<ShadowTuiHostLimits> = {
  maxViews: 32,
  maxChannelsPerView: DASH_DEFAULT_LIMITS.maxSubscriptionsPerConnection,
  maxReplayEvents: DASH_DEFAULT_LIMITS.maxReplayEvents,
  maxReplayBytes: DASH_DEFAULT_LIMITS.maxReplayBytesPerSession,
  maxFrameBytes: DASH_DEFAULT_LIMITS.maxTuiDeltaBytes,
  maxPasteBytes: 256 * 1024,
};

export class ShadowTuiHostError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "ShadowTuiHostError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ShadowTuiHostOptions<Runtime = unknown> {
  resolveRuntime(identity: DashboardSessionIdentity): Runtime | Promise<Runtime>;
  viewFactory: ShadowInteractiveSessionViewFactory<Runtime>;
  extensionBroker: ShadowTuiExtensionBroker;
  limits?: Partial<ShadowTuiHostLimits>;
}

interface RetainedDelta {
  sequence: number;
  cursor: DashboardCursor;
  delta: DashboardTuiDelta;
  bytes: number;
}

/**
 * Canonical server-side shadow TUI host.
 *
 * Construction requires the proposed host-safe InteractiveSessionView facade;
 * production must leave TUI capability unavailable until that factory exists.
 * This class never imports or constructs InteractiveMode/ProcessTerminal and
 * never binds extensions itself.
 */
export class ShadowTuiHost<Runtime = unknown> implements InProcessDashboardTuiChannels {
  readonly available = true;
  readonly limits: ShadowTuiHostLimits;
  readonly #resolveRuntime: ShadowTuiHostOptions<Runtime>["resolveRuntime"];
  readonly #viewFactory: ShadowInteractiveSessionViewFactory<Runtime>;
  readonly #extensionBroker: ShadowTuiExtensionBroker;
  readonly #hubs = new Map<string, Promise<ShadowTuiHub<Runtime>>>();
  #disposed = false;

  constructor(options: ShadowTuiHostOptions<Runtime>) {
    this.#resolveRuntime = options.resolveRuntime;
    this.#viewFactory = options.viewFactory;
    this.#extensionBroker = options.extensionBroker;
    this.limits = resolveLimits(options.limits);
  }

  async open(context: Parameters<InProcessDashboardTuiChannels["open"]>[0]): Promise<DashboardTuiChannel> {
    this.#assertOpen();
    const key = identityKey(context.identity);
    let pending = this.#hubs.get(key);
    if (pending === undefined) {
      if (this.#hubs.size >= this.limits.maxViews) {
        throw new ShadowTuiHostError("shadow_tui_capacity", "shadow TUI view capacity reached", true);
      }
      pending = this.#createHub(context.identity, context.options.dimensions);
      this.#hubs.set(key, pending);
      void pending.catch(() => {
        if (this.#hubs.get(key) === pending) this.#hubs.delete(key);
      });
    }
    const hub = await pending;
    return hub.open(context.options);
  }

  invalidate(identity: DashboardSessionIdentity, reason = "session generation replaced"): void {
    const key = identityKey(identity);
    const pending = this.#hubs.get(key);
    if (pending === undefined) return;
    this.#hubs.delete(key);
    void pending.then((hub) => hub.dispose(reason)).catch(() => undefined);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#hubs.values()) {
      void pending.then((hub) => hub.dispose("shadow TUI host disposed")).catch(() => undefined);
    }
    this.#hubs.clear();
  }

  async #createHub(
    identity: DashboardSessionIdentity,
    dimensions: TuiDimensions,
  ): Promise<ShadowTuiHub<Runtime>> {
    const runtime = await this.#resolveRuntime(identity);
    const hub = new ShadowTuiHub(
      identity,
      runtime,
      dimensions,
      this.#viewFactory,
      this.#extensionBroker,
      this.limits,
      () => this.#hubs.delete(identityKey(identity)),
    );
    await hub.init();
    return hub;
  }

  #assertOpen(): void {
    if (this.#disposed) throw new ShadowTuiHostError("shadow_tui_closed", "shadow TUI host is closed");
  }
}

class ShadowTuiHub<Runtime> {
  readonly identity: DashboardSessionIdentity;
  readonly terminal: VirtualTerminal;
  readonly #runtime: Runtime;
  readonly #viewFactory: ShadowInteractiveSessionViewFactory<Runtime>;
  readonly #extensionBroker: ShadowTuiExtensionBroker;
  readonly #limits: ShadowTuiHostLimits;
  readonly #onIdle: () => void;
  readonly #channels = new Map<string, ShadowTuiChannel>();
  readonly #replay: RetainedDelta[] = [];
  #view: ShadowInteractiveSessionView | undefined;
  #releaseBroker: (() => void) | undefined;
  #unsubscribeTerminal: (() => void) | undefined;
  #controllerChannelId: string | undefined;
  #snapshot: DashboardTuiSnapshot | undefined;
  #sequence = 0;
  #replayBytes = 0;
  #publicationScheduled = false;
  #initialized = false;
  #disposed = false;

  constructor(
    identity: DashboardSessionIdentity,
    runtime: Runtime,
    dimensions: TuiDimensions,
    viewFactory: ShadowInteractiveSessionViewFactory<Runtime>,
    extensionBroker: ShadowTuiExtensionBroker,
    limits: ShadowTuiHostLimits,
    onIdle: () => void,
  ) {
    validateDimensions(dimensions);
    this.identity = identity;
    this.#runtime = runtime;
    this.#viewFactory = viewFactory;
    this.#extensionBroker = extensionBroker;
    this.#limits = limits;
    this.#onIdle = onIdle;
    this.terminal = new VirtualTerminal(dimensions.columns, dimensions.rows);
  }

  async init(): Promise<void> {
    const view = this.#viewFactory.create(this.#runtime, {
      host: {
        terminal: this.terminal,
        requestExit: ({ reason }) => this.dispose(`interactive view requested exit: ${reason}`),
        resolveAutocompleteTool: async () => undefined,
      },
      extensionBinding: "external",
    });
    this.#view = view;
    this.#releaseBroker = this.#extensionBroker.bind(this.identity, view.extensionUI);
    this.#unsubscribeTerminal = this.terminal.subscribeFramePending(() => this.#schedulePublication());
    try {
      await view.init();
      if (this.#disposed) throw new ShadowTuiHostError("shadow_tui_closed", "interactive view exited during initialization");
      view.requestRender(true);
      await immediate();
      this.#snapshot = snapshotFromFrame(this.identity, this.terminal.takeFrame({ force: true }), this.#cursor(0));
      this.#initialized = true;
    } catch (error) {
      this.dispose("interactive view initialization failed");
      throw error;
    }
  }

  open(options: TuiChannelOptions): DashboardTuiChannel {
    this.#assertOpen();
    if (!this.#initialized || this.#snapshot === undefined) {
      throw new ShadowTuiHostError("shadow_tui_not_ready", "shadow TUI view is not ready", true);
    }
    if (this.#channels.size >= this.#limits.maxChannelsPerView) {
      throw new ShadowTuiHostError("shadow_tui_channel_capacity", "shadow TUI channel capacity reached", true);
    }
    const id = randomUUID();
    const controllerGranted = options.role === "controller" && this.#controllerChannelId === undefined;
    if (controllerGranted) this.#controllerChannelId = id;
    const role = controllerGranted ? "controller" : "observer";
    if (controllerGranted) this.#resize(options.dimensions);
    const pending = this.#eventsAfter(options.cursor);
    if (options.role === "controller" && !controllerGranted) {
      pending.push({
        kind: "control",
        identity: this.identity,
        action: "control_denied",
        connectionId: id,
        reason: "controller already held",
      });
    }
    const channel = new ShadowTuiChannel(
      id,
      role,
      structuredClone(this.#snapshot),
      options.dimensions,
      pending,
      this,
    );
    this.#channels.set(id, channel);
    return channel;
  }

  resize(channelId: string, dimensions: TuiDimensions): void {
    this.#assertController(channelId);
    this.#resize(dimensions);
  }

  sendInput(channelId: string, input: DashboardTuiInput): void {
    this.#assertController(channelId);
    const chunks = encodeInput(input, this.#limits.maxPasteBytes);
    for (const chunk of chunks) this.terminal.sendInput(chunk);
    this.#view?.requestRender(false);
    this.#schedulePublication();
  }

  requestControl(channelId: string, correlationId: string): DashboardCommandResult {
    const channel = this.#requireChannel(channelId);
    if (this.#controllerChannelId !== undefined && this.#controllerChannelId !== channelId) {
      channel.deliver({
        kind: "control",
        identity: this.identity,
        action: "control_denied",
        connectionId: channelId,
        reason: "controller already held",
      });
      return rejected(correlationId, "controller_busy", "another pane holds TUI controller role", true);
    }
    this.#controllerChannelId = channelId;
    channel.setRole("controller");
    this.#resize(channel.requestedDimensions);
    this.#broadcast({
      kind: "control",
      identity: this.identity,
      action: "control_granted",
      connectionId: channelId,
    });
    return { correlationId, state: "completed", data: { role: "controller" } };
  }

  releaseControl(channelId: string, correlationId: string): DashboardCommandResult {
    const channel = this.#requireChannel(channelId);
    if (this.#controllerChannelId !== channelId) {
      return rejected(correlationId, "controller_required", "pane does not hold TUI controller role");
    }
    this.#controllerChannelId = undefined;
    channel.setRole("observer");
    this.#broadcast({
      kind: "control",
      identity: this.identity,
      action: "control_released",
      connectionId: channelId,
    });
    return { correlationId, state: "completed", data: { role: "observer" } };
  }

  remove(channelId: string): void {
    const channel = this.#channels.get(channelId);
    if (channel === undefined) return;
    this.#channels.delete(channelId);
    if (this.#controllerChannelId === channelId) {
      this.#controllerChannelId = undefined;
      this.#broadcast({
        kind: "control",
        identity: this.identity,
        action: "control_released",
        connectionId: channelId,
      });
    }
    if (this.#channels.size === 0) {
      this.dispose("last TUI channel closed");
      this.#onIdle();
    }
  }

  dispose(_reason: string): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#publicationScheduled = false;
    this.#unsubscribeTerminal?.();
    this.#unsubscribeTerminal = undefined;
    this.#view?.stop();
    this.#view = undefined;
    this.#releaseBroker?.();
    this.#releaseBroker = undefined;
    this.terminal.stop();
    for (const channel of [...this.#channels.values()]) channel.forceClose();
    this.#channels.clear();
    this.#replay.length = 0;
  }

  #resize(dimensions: TuiDimensions): void {
    validateDimensions(dimensions);
    if (
      dimensions.columns === this.terminal.columns &&
      dimensions.rows === this.terminal.rows
    ) return;
    this.terminal.resize(dimensions.columns, dimensions.rows);
    this.#view?.requestRender(true);
    this.#schedulePublication();
  }

  #schedulePublication(): void {
    if (!this.#initialized || this.#disposed || this.#publicationScheduled) return;
    this.#publicationScheduled = true;
    setImmediate(() => {
      this.#publicationScheduled = false;
      if (this.#disposed) return;
      this.#publish();
    });
  }

  #publish(): void {
    let frame: VirtualTerminalFrame;
    try {
      frame = this.terminal.takeFrame();
    } catch {
      return;
    }
    const sequence = ++this.#sequence;
    const cursor = this.#cursor(sequence);
    const delta = deltaFromFrame(this.identity, frame, cursor, sequence);
    const bytes = Buffer.byteLength(JSON.stringify(delta), "utf8");
    if (bytes > this.#limits.maxFrameBytes) {
      this.dispose("TUI frame exceeded host byte bound");
      return;
    }
    this.#snapshot = snapshotFromFrame(this.identity, frame, cursor);
    this.#replay.push({ sequence, cursor, delta, bytes });
    this.#replayBytes += bytes;
    while (
      this.#replay.length > this.#limits.maxReplayEvents ||
      this.#replayBytes > this.#limits.maxReplayBytes
    ) {
      const removed = this.#replay.shift();
      if (removed) this.#replayBytes -= removed.bytes;
    }
    this.#broadcast(delta);
  }

  #eventsAfter(cursor: DashboardCursor | undefined): DashboardTuiChannelEvent[] {
    if (cursor === undefined) return [];
    const parsed = parseCursor(cursor);
    const highWaterCursor = this.#snapshot?.highWaterCursor ?? this.#cursor(this.#sequence);
    if (parsed === undefined) return [gap(this.identity, cursor, highWaterCursor, "cursor-expired")];
    if (parsed.hostInstanceId !== this.identity.hostInstanceId) {
      return [gap(this.identity, cursor, highWaterCursor, "host-restarted")];
    }
    if (
      parsed.sessionId !== this.identity.sessionId ||
      parsed.generation !== this.identity.generation
    ) {
      return [gap(this.identity, cursor, highWaterCursor, "generation-changed")];
    }
    if (parsed.sequence === this.#sequence) return [];
    const oldest = this.#replay[0];
    if (oldest === undefined || parsed.sequence < oldest.sequence - 1 || parsed.sequence > this.#sequence) {
      return [gap(this.identity, cursor, highWaterCursor, "cursor-expired", oldest?.cursor)];
    }
    return this.#replay.filter((entry) => entry.sequence > parsed.sequence).map((entry) => structuredClone(entry.delta));
  }

  #cursor(sequence: number): DashboardCursor {
    return encodeCursor({ ...this.identity, sequence });
  }

  #broadcast(event: DashboardTuiChannelEvent): void {
    for (const channel of this.#channels.values()) channel.deliver(event);
  }

  #requireChannel(channelId: string): ShadowTuiChannel {
    const channel = this.#channels.get(channelId);
    if (channel === undefined) throw new ShadowTuiHostError("shadow_tui_channel_closed", "TUI channel is closed");
    return channel;
  }

  #assertController(channelId: string): void {
    const channel = this.#requireChannel(channelId);
    if (this.#controllerChannelId !== channelId || channel.role !== "controller") {
      throw new ShadowTuiHostError("controller_required", "TUI controller role is required");
    }
  }

  #assertOpen(): void {
    if (this.#disposed) throw new ShadowTuiHostError("shadow_tui_closed", "shadow TUI view is closed");
  }
}

class ShadowTuiChannel implements DashboardTuiChannel {
  readonly presentation = "tui" as const;
  readonly identity;
  readonly snapshot;
  readonly requestedDimensions: TuiDimensions;
  readonly #id: string;
  readonly #hub: ShadowTuiHub<unknown>;
  readonly #pending: DashboardTuiChannelEvent[];
  readonly #listeners = new Set<DashboardChannelListener<DashboardTuiChannelEvent>>();
  #role: "controller" | "observer";
  #closed = false;

  constructor(
    id: string,
    role: "controller" | "observer",
    snapshot: DashboardTuiSnapshot,
    requestedDimensions: TuiDimensions,
    pending: DashboardTuiChannelEvent[],
    hub: ShadowTuiHub<unknown>,
  ) {
    this.#id = id;
    this.#role = role;
    this.snapshot = snapshot;
    this.identity = snapshot.identity;
    this.requestedDimensions = { ...requestedDimensions };
    this.#pending = pending;
    this.#hub = hub;
  }

  get role(): "controller" | "observer" {
    return this.#role;
  }

  setRole(role: "controller" | "observer"): void {
    this.#role = role;
  }

  async resize(dimensions: TuiDimensions): Promise<void> {
    this.#assertOpen();
    this.requestedDimensions.rows = dimensions.rows;
    this.requestedDimensions.columns = dimensions.columns;
    this.#hub.resize(this.#id, dimensions);
  }

  async sendInput(input: DashboardTuiInput): Promise<void> {
    this.#assertOpen();
    this.#hub.sendInput(this.#id, input);
  }

  async requestControl(correlationId: string): Promise<DashboardCommandResult> {
    this.#assertOpen();
    return this.#hub.requestControl(this.#id, correlationId);
  }

  async releaseControl(correlationId: string): Promise<DashboardCommandResult> {
    this.#assertOpen();
    return this.#hub.releaseControl(this.#id, correlationId);
  }

  subscribe(listener: DashboardChannelListener<DashboardTuiChannelEvent>): () => void {
    this.#assertOpen();
    this.#listeners.add(listener);
    for (const event of this.#pending.splice(0)) listener(structuredClone(event));
    return () => this.#listeners.delete(listener);
  }

  deliver(event: DashboardTuiChannelEvent): void {
    if (this.#closed) return;
    for (const listener of this.#listeners) listener(structuredClone(event));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.#hub.remove(this.#id);
  }

  forceClose(): void {
    this.#closed = true;
    this.#listeners.clear();
  }

  #assertOpen(): void {
    if (this.#closed) throw new ShadowTuiHostError("shadow_tui_channel_closed", "TUI channel is closed");
  }
}

function snapshotFromFrame(
  identity: DashboardSessionIdentity,
  frame: VirtualTerminalFrame,
  cursor: DashboardCursor,
): DashboardTuiSnapshot {
  return {
    identity,
    dimensions: { rows: frame.rows, columns: frame.columns },
    rows: rowsFromFrame(frame),
    cursor: {
      row: frame.cursor.row,
      column: frame.cursor.column,
      visible: frame.cursor.visible,
      shape: "block",
    },
    ...(frame.title.length === 0 ? {} : { title: frame.title }),
    highWaterCursor: cursor,
  };
}

function deltaFromFrame(
  identity: DashboardSessionIdentity,
  frame: VirtualTerminalFrame,
  cursor: DashboardCursor,
  sequence: number,
): DashboardTuiDelta {
  return {
    kind: "tui_delta",
    identity,
    cursor,
    sequence,
    dimensions: { rows: frame.rows, columns: frame.columns },
    changedRows: rowsFromFrame(frame),
    cursorState: {
      row: frame.cursor.row,
      column: frame.cursor.column,
      visible: frame.cursor.visible,
      shape: "block",
    },
    ...(frame.title.length === 0 ? {} : { title: frame.title }),
  };
}

function rowsFromFrame(frame: VirtualTerminalFrame): TuiRow[] {
  return frame.changedRows.map((row) => ({
    row: row.row,
    runs: row.runs.map((run) => {
      const style = styleFromVirtual(run.style);
      return { text: run.text, ...(style === undefined ? {} : { style }) };
    }),
  }));
}

function styleFromVirtual(style: VirtualTerminalStyle): TuiStyle | undefined {
  const foreground = style.foreground === undefined ? undefined : colorHex(style.foreground);
  const background = style.background === undefined ? undefined : colorHex(style.background);
  const value: TuiStyle = {
    ...(foreground === undefined ? {} : { foreground }),
    ...(background === undefined ? {} : { background }),
    ...(style.bold === true ? { bold: true } : {}),
    ...(style.dim === true ? { dim: true } : {}),
    ...(style.italic === true ? { italic: true } : {}),
    ...(style.underline === true ? { underline: true } : {}),
    ...(style.inverse === true ? { inverse: true } : {}),
  };
  return Object.keys(value).length === 0 ? undefined : value;
}

const ANSI16 = [
  "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
  "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
] as const;

function colorHex(color: VirtualTerminalColor): string {
  if (color.mode === "rgb") {
    return `#${hex(color.red)}${hex(color.green)}${hex(color.blue)}`;
  }
  const index = Math.max(0, Math.min(255, color.value));
  if (index < 16) return ANSI16[index]!;
  if (index < 232) {
    const cube = index - 16;
    const red = Math.floor(cube / 36);
    const green = Math.floor((cube % 36) / 6);
    const blue = cube % 6;
    const level = (value: number) => value === 0 ? 0 : 55 + value * 40;
    return `#${hex(level(red))}${hex(level(green))}${hex(level(blue))}`;
  }
  const gray = 8 + (index - 232) * 10;
  return `#${hex(gray)}${hex(gray)}${hex(gray)}`;
}

function hex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
}

function encodeInput(input: DashboardTuiInput, maxPasteBytes: number): string[] {
  if (input.type === "text") {
    return boundedChunks(
      input.text,
      DEFAULT_VIRTUAL_TERMINAL_LIMITS.maxInputBytes,
      DEFAULT_VIRTUAL_TERMINAL_LIMITS.maxInputBytes,
    );
  }
  if (input.type === "paste") {
    return boundedChunks(input.text, DEFAULT_VIRTUAL_TERMINAL_LIMITS.maxInputBytes, maxPasteBytes);
  }
  return [encodeKey(input.key, input.modifiers ?? [])];
}

function encodeKey(key: string, modifiers: Array<"ctrl" | "alt" | "shift" | "meta">): string {
  if (modifiers.includes("meta")) throw new ShadowTuiHostError("unsupported_tui_input", "meta-modified TUI keys are unsupported");
  const normalized = key.length === 1 && modifiers.includes("shift") ? key.toUpperCase() : key;
  let encoded: string | undefined;
  if (modifiers.includes("ctrl") && /^[a-z]$/iu.test(normalized)) {
    encoded = String.fromCharCode(normalized.toUpperCase().charCodeAt(0) - 64);
  } else if (normalized.length === 1 && !modifiers.includes("ctrl")) {
    encoded = normalized;
  } else {
    encoded = ({
      Enter: "\r",
      Tab: "\t",
      Backspace: "\u007f",
      Escape: "\u001b",
      ArrowUp: "\u001b[A",
      ArrowDown: "\u001b[B",
      ArrowRight: "\u001b[C",
      ArrowLeft: "\u001b[D",
      Home: "\u001b[H",
      End: "\u001b[F",
      Delete: "\u001b[3~",
      PageUp: "\u001b[5~",
      PageDown: "\u001b[6~",
    } as Record<string, string>)[normalized];
  }
  if (encoded === undefined) throw new ShadowTuiHostError("unsupported_tui_input", `unsupported TUI key: ${key}`);
  return modifiers.includes("alt") ? `\u001b${encoded}` : encoded;
}

function boundedChunks(text: string, maxChunkBytes: number, maxTotalBytes: number): string[] {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxTotalBytes) throw new ShadowTuiHostError("tui_input_too_large", "TUI paste exceeds its byte bound");
  if (bytes <= maxChunkBytes) return [text];
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (currentBytes + size > maxChunkBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function validateDimensions(dimensions: TuiDimensions): void {
  if (
    !Number.isInteger(dimensions.columns) || dimensions.columns < 1 ||
    dimensions.columns > DEFAULT_VIRTUAL_TERMINAL_LIMITS.maxColumns ||
    !Number.isInteger(dimensions.rows) || dimensions.rows < 1 ||
    dimensions.rows > DEFAULT_VIRTUAL_TERMINAL_LIMITS.maxRows
  ) {
    throw new ShadowTuiHostError("invalid_tui_dimensions", "TUI dimensions exceed virtual terminal bounds");
  }
}

function resolveLimits(overrides: Partial<ShadowTuiHostLimits> | undefined): ShadowTuiHostLimits {
  const limits = { ...DEFAULT_SHADOW_TUI_HOST_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  }
  if (limits.maxFrameBytes > DEFAULT_VIRTUAL_TERMINAL_LIMITS.maxFrameBytes) {
    throw new RangeError("maxFrameBytes exceeds the VirtualTerminal hard ceiling");
  }
  return limits;
}

function identityKey(identity: DashboardSessionIdentity): string {
  return `${identity.hostInstanceId}\u0000${identity.sessionId}\u0000${identity.generation}`;
}

function encodeCursor(value: DashboardSessionIdentity & { sequence: number }): DashboardCursor {
  return asDashboardCursor(`tui:${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`);
}

function parseCursor(cursor: DashboardCursor): (DashboardSessionIdentity & { sequence: number }) | undefined {
  try {
    if (!cursor.startsWith("tui:")) return undefined;
    const value: unknown = JSON.parse(Buffer.from(cursor.slice(4), "base64url").toString("utf8"));
    if (
      typeof value !== "object" || value === null || Array.isArray(value) ||
      typeof (value as Record<string, unknown>).hostInstanceId !== "string" ||
      typeof (value as Record<string, unknown>).sessionId !== "string" ||
      !Number.isInteger((value as Record<string, unknown>).generation) ||
      !Number.isInteger((value as Record<string, unknown>).sequence)
    ) return undefined;
    const record = value as Record<string, unknown>;
    return {
      hostInstanceId: record.hostInstanceId as string,
      sessionId: record.sessionId as string,
      generation: record.generation as number,
      sequence: record.sequence as number,
    };
  } catch {
    return undefined;
  }
}

function gap(
  identity: DashboardSessionIdentity,
  requestedCursor: DashboardCursor,
  highWaterCursor: DashboardCursor,
  reason: DashboardReplayGap["reason"],
  oldestAvailableCursor?: DashboardCursor,
): DashboardReplayGap {
  return {
    kind: "replay_gap",
    identity,
    reason,
    requestedCursor,
    highWaterCursor,
    ...(oldestAvailableCursor === undefined ? {} : { oldestAvailableCursor }),
    snapshotFollows: true,
  };
}

function rejected(
  correlationId: string,
  code: string,
  message: string,
  retryable = false,
): DashboardCommandResult {
  return { correlationId, state: "rejected", error: { code, message, retryable } };
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
