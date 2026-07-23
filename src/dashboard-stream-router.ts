import {
  DASH_API_VERSION,
  type DashStreamServerFrame,
  type DashboardBackend,
  type DashboardChannel,
  type DashboardChannelEvent,
  type DashboardCommandOperation,
  type DashboardCommandResult,
  type DashboardLimits,
  type DashboardPresentation,
  type DashboardSessionIdentity,
  type DashboardTuiChannel,
  type DashboardTuiChannelEvent,
  type DashboardTuiInput,
  asDashboardCursor,
} from "./dashboard-contract.js";
import type { JsonObject } from "./session-api.js";
import type { DashboardAuthenticatedSession } from "./dashboard-auth.js";
import type {
  DashboardResourceRef,
  DashboardResourceRole,
} from "./dashboard-authorization.js";
import type { DashboardAuthorizationEnforcer } from "./dashboard-authorization-enforcer.js";
import type {
  DashboardStreamHandler,
  DashboardWebSocketPeer,
} from "./dashboard-server.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_PENDING_AUTHORIZED_EVENTS_PER_SUBSCRIPTION = 64;
const READ_ONLY_COMMANDS = new Set<DashboardCommandOperation>([
  "get_state", "get_entries", "get_session_stats", "get_commands",
  "get_available_models", "get_tree",
]);
const COMMANDS = new Set<DashboardCommandOperation>([
  "get_state", "get_entries", "get_session_stats", "get_commands",
  "get_available_models", "prompt", "steer", "follow_up", "abort",
  "set_model", "set_thinking_level", "set_steering_mode", "set_follow_up_mode",
  "compact", "set_auto_compaction", "set_auto_retry", "abort_retry",
  "set_session_name", "get_tree", "navigate_tree", "fork", "clone",
]);

export interface DashboardStreamRouterOptions {
  backend: DashboardBackend;
  authorization: DashboardAuthorizationEnforcer;
  serverInstanceId: string;
  limits: Pick<DashboardLimits,
    | "maxSubscriptionsPerConnection"
    | "maxInFlightCommandsPerConnection"
    | "maxTuiRows"
    | "maxTuiColumns"
  >;
}

type StreamPeer = Pick<DashboardWebSocketPeer, "send" | "onMessage" | "onClose" | "close">;
type Channel = DashboardChannel | DashboardTuiChannel;

interface Subscription {
  channel: Channel;
  authorization: DashboardResourceRef;
  requiredRole: DashboardResourceRole;
  eventQueue: Array<{
    correlationId: string;
    event: DashboardChannelEvent | DashboardTuiChannelEvent;
  }>;
  authorizingEvents: boolean;
  unsubscribe: () => void;
}

interface ParsedBase {
  dashVersion: typeof DASH_API_VERSION;
  kind: string;
  clientId: string;
  workspaceId: string;
  correlationId: string;
}

/**
 * Transport-neutral, per-peer browser stream router. It receives only an
 * authenticated browser identity and the bounded peer seam; daemon bearer
 * credentials and raw sockets are deliberately outside this boundary.
 */
export class DashboardStreamRouter {
  readonly #backend: DashboardBackend;
  readonly #authorization: DashboardAuthorizationEnforcer;
  readonly #serverInstanceId: string;
  readonly #limits: DashboardStreamRouterOptions["limits"];

  constructor(options: DashboardStreamRouterOptions) {
    this.#backend = options.backend;
    this.#authorization = options.authorization;
    this.#serverInstanceId = boundedId(options.serverInstanceId, "serverInstanceId");
    this.#limits = options.limits;
  }

  handle(context: {
    session: DashboardAuthenticatedSession;
    revalidateSession?: () => DashboardAuthenticatedSession;
    peer: StreamPeer;
  }): void {
    const connection = new DashboardStreamConnection(
      this.#backend,
      this.#authorization,
      this.#serverInstanceId,
      this.#limits,
      context.session,
      context.revalidateSession ?? (() => context.session),
      context.peer,
    );
    connection.start();
  }
}

export function createDashboardStreamHandler(
  options: DashboardStreamRouterOptions,
): DashboardStreamHandler {
  const router = new DashboardStreamRouter(options);
  return (context) => router.handle(context);
}

class DashboardStreamConnection {
  readonly #backend: DashboardBackend;
  readonly #authorization: DashboardAuthorizationEnforcer;
  readonly #serverInstanceId: string;
  readonly #limits: DashboardStreamRouterOptions["limits"];
  readonly #session: DashboardAuthenticatedSession;
  readonly #revalidateSession: () => DashboardAuthenticatedSession;
  readonly #peer: StreamPeer;
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #pendingOpens = new Set<string>();
  readonly #inFlight = new Set<Promise<void>>();
  #messageTail: Promise<void> = Promise.resolve();
  #closed = false;
  #helloReceived = false;

  constructor(
    backend: DashboardBackend,
    authorization: DashboardAuthorizationEnforcer,
    serverInstanceId: string,
    limits: DashboardStreamRouterOptions["limits"],
    session: DashboardAuthenticatedSession,
    revalidateSession: () => DashboardAuthenticatedSession,
    peer: StreamPeer,
  ) {
    this.#backend = backend;
    this.#authorization = authorization;
    this.#serverInstanceId = serverInstanceId;
    this.#limits = limits;
    this.#session = session;
    this.#revalidateSession = revalidateSession;
    this.#peer = peer;
  }

  start(): void {
    this.#peer.onClose(() => void this.#closeAll());
    this.#peer.onMessage((text) => {
      // Admission and channel mutation are serialized. Accepted backend work is
      // not retained or replayed by this connection after disconnect.
      this.#messageTail = this.#messageTail
        .then(() => this.#onMessage(text))
        .catch(() => this.#fatal());
    });
  }

  async #onMessage(text: string): Promise<void> {
    if (this.#closed) return;
    try {
      this.#revalidateSession();
    } catch {
      this.#peer.close(1008, "browser session revoked");
      await this.#closeAll();
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.#sendError("invalid-frame", "invalid_json", "dashboard frame is not valid JSON");
      return;
    }
    let frame: ParsedBase & Record<string, unknown>;
    try {
      frame = parseBase(value, this.#session);
    } catch (error) {
      const safe = streamError(error);
      this.#sendError(correlationFrom(value), safe.code, safe.message, safe.retryable);
      return;
    }

    try {
      switch (frame.kind) {
        case "hello": await this.#hello(frame); break;
        case "subscribe": await this.#subscribe(frame); break;
        case "unsubscribe": await this.#unsubscribe(frame); break;
        case "command": this.#command(frame); break;
        case "control": this.#control(frame); break;
        case "extension_ui_response": this.#extensionUi(frame); break;
        case "tui_resize": this.#resize(frame); break;
        case "tui_input": this.#input(frame); break;
        case "seen":
          this.#sendError(frame.correlationId, "unsupported_frame", "seen acknowledgement requires the workspace resource");
          break;
        default:
          throw new StreamFrameError("unsupported_frame", "dashboard frame kind is unsupported");
      }
    } catch (error) {
      const safe = streamError(error);
      this.#sendError(frame.correlationId, safe.code, safe.message, safe.retryable);
    }
  }

  async #hello(frame: ParsedBase & Record<string, unknown>): Promise<void> {
    if (this.#helloReceived) throw new StreamFrameError("duplicate_hello", "hello was already received");
    if (frame.requestedVersion !== DASH_API_VERSION) {
      throw new StreamFrameError("version_mismatch", "dashboard protocol version is unsupported");
    }
    this.#helloReceived = true;
    const capabilities = await this.#backend.capabilities();
    this.#send({ ...this.#envelope(frame.correlationId), kind: "ready", capabilities });
  }

  async #subscribe(frame: ParsedBase & Record<string, unknown>): Promise<void> {
    this.#requireHello();
    const subscriptionId = requiredId(frame.subscriptionId, "subscriptionId");
    if (this.#subscriptions.has(subscriptionId) || this.#pendingOpens.has(subscriptionId)) {
      throw new StreamFrameError("subscription_conflict", "subscriptionId is already open");
    }
    if (this.#subscriptions.size + this.#pendingOpens.size >= this.#limits.maxSubscriptionsPerConnection) {
      throw new StreamFrameError("subscription_capacity", "subscription capacity is exhausted", true);
    }
    const presentation = requiredEnum(frame.presentation, ["rich", "tui"] as const, "presentation");
    const role = requiredEnum(frame.role, ["observer", "controller"] as const, "role");
    const generation = optionalNonNegativeInteger(frame.generation, "generation");
    const cursor = optionalCursor(frame.cursor);
    const requiredRole: DashboardResourceRole = role === "controller" ? "control" : "read";
    const target = await this.#resolveSessionRef(frame, requiredRole);
    this.#pendingOpens.add(subscriptionId);
    let channel: Channel | undefined;
    try {
      channel = presentation === "rich"
        ? await this.#backend.openSessionChannel({ sessionRef: target.sessionRef, role, ...(generation === undefined ? {} : { generation }), ...(cursor === undefined ? {} : { cursor }) })
        : await this.#backend.openTuiChannel({
            sessionRef: target.sessionRef,
            role,
            ...(generation === undefined ? {} : { generation }),
            ...(cursor === undefined ? {} : { cursor }),
            dimensions: dimensions(frame.tuiDimensions, this.#limits),
          });
      if (this.#closed) {
        await channel.close();
        return;
      }
      const expectedPresentation: DashboardPresentation = presentation;
      if (channel.presentation !== expectedPresentation) throw new StreamFrameError("backend_contract", "backend returned the wrong presentation");
      assertIdentity(channel.snapshot.identity, channel.identity);

      const buffered: Array<DashboardChannelEvent | DashboardTuiChannelEvent> = [];
      let ready = false;
      const unsubscribe = channel.subscribe((event) => {
        if (!sameIdentity(event.identity, channel!.identity)) {
          this.#peer.close(1011, "dashboard channel identity mismatch");
          void this.#closeAll();
          return;
        }
        if (!ready) {
          if (buffered.length >= MAX_PENDING_AUTHORIZED_EVENTS_PER_SUBSCRIPTION) {
            this.#peer.close(1009, "dashboard authorization event bound exceeded");
            void this.#closeAll();
            return;
          }
          buffered.push(event);
        } else this.#queueAuthorizedEvent(subscriptionId, frame.correlationId, event);
      });
      if (this.#closed) {
        unsubscribe();
        await channel.close();
        return;
      }
      await this.#authorization.require(
        this.#session.principal,
        target.authorization,
        requiredRole,
      );
      this.#revalidateSession();
      this.#subscriptions.set(subscriptionId, {
        channel,
        authorization: target.authorization,
        requiredRole,
        eventQueue: [],
        authorizingEvents: false,
        unsubscribe,
      });
      for (const event of buffered.filter((candidate) => candidate.kind === "replay_gap")) {
        this.#sendEvent(subscriptionId, frame.correlationId, channel, event);
      }
      this.#send({
        ...this.#envelope(frame.correlationId),
        kind: "subscription_ready",
        subscriptionId,
        presentation,
        role: channel.role,
        identity: channel.identity,
        highWaterCursor: channel.snapshot.highWaterCursor,
        snapshot: channel.snapshot,
      });
      ready = true;
      for (const event of buffered.filter((candidate) => candidate.kind !== "replay_gap")) {
        this.#sendEvent(subscriptionId, frame.correlationId, channel, event);
      }
    } catch (error) {
      if (channel !== undefined && !this.#subscriptions.has(subscriptionId)) await channel.close().catch(() => undefined);
      throw error;
    } finally {
      this.#pendingOpens.delete(subscriptionId);
    }
  }

  async #resolveSessionRef(
    frame: Record<string, unknown>,
    requiredRole: DashboardResourceRole,
  ): Promise<{ sessionRef: string; authorization: DashboardResourceRef }> {
    const hasInventory = frame.inventoryId !== undefined;
    const hasSession = frame.sessionRef !== undefined;
    if (hasInventory === hasSession) throw new StreamFrameError("invalid_frame", "subscribe requires exactly one session reference");
    if (hasSession) {
      const sessionRef = requiredId(frame.sessionRef, "sessionRef");
      const decision = await this.#authorization.requireManagedSession(
        this.#session.principal,
        sessionRef,
        requiredRole,
      );
      return { sessionRef, authorization: decision.resource };
    }
    const decision = await this.#authorization.requireInventorySession(
      this.#session.principal,
      requiredId(frame.inventoryId, "inventoryId"),
      requiredRole,
    );
    const info = decision.info;
    if (info.managed === undefined) throw new StreamFrameError("session_not_managed", "inventory session is not managed");
    if (frame.generation !== undefined && frame.generation !== info.managed.generation) {
      throw new StreamFrameError("stale_generation", "session generation changed");
    }
    return { sessionRef: info.managed.sessionId, authorization: decision.resource };
  }

  async #unsubscribe(frame: ParsedBase & Record<string, unknown>): Promise<void> {
    const id = requiredId(frame.subscriptionId, "subscriptionId");
    const subscription = this.#requireSubscription(id);
    this.#subscriptions.delete(id);
    subscription.eventQueue.length = 0;
    subscription.unsubscribe();
    await subscription.channel.close();
  }

  #command(frame: ParsedBase & Record<string, unknown>): void {
    this.#requireHello();
    const id = requiredId(frame.subscriptionId, "subscriptionId");
    const subscription = this.#requireSubscription(id);
    if (subscription.channel.presentation !== "rich") throw new StreamFrameError("presentation_mismatch", "commands require a rich subscription");
    const channel = subscription.channel;
    const operation = requiredEnum(frame.operation, [...COMMANDS], "operation");
    const idempotencyKey = optionalBoundedText(frame.idempotencyKey, "idempotencyKey", 512);
    const payload = optionalObject(frame.payload, "payload");
    this.#launch(frame.correlationId, async () => {
      await this.#authorizeSubscription(
        id,
        READ_ONLY_COMMANDS.has(operation) ? "read" : "control",
      );
      const result = await channel.command({
        correlationId: frame.correlationId,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        identity: channel.identity,
        operation,
        ...(payload === undefined ? {} : { payload }),
      });
      this.#commandResult(id, frame.correlationId, result);
    });
  }

  #control(frame: ParsedBase & Record<string, unknown>): void {
    this.#requireHello();
    const id = requiredId(frame.subscriptionId, "subscriptionId");
    const channel = this.#requireSubscription(id).channel;
    const action = requiredEnum(frame.action, ["request", "release"] as const, "action");
    this.#launch(frame.correlationId, async () => {
      await this.#authorizeSubscription(id, "control");
      const result = action === "request"
        ? await channel.requestControl(frame.correlationId)
        : await channel.releaseControl(frame.correlationId);
      this.#commandResult(id, frame.correlationId, result);
    });
  }

  #extensionUi(frame: ParsedBase & Record<string, unknown>): void {
    this.#requireHello();
    const id = requiredId(frame.subscriptionId, "subscriptionId");
    const channel = this.#requireSubscription(id).channel;
    if (channel.presentation !== "rich") throw new StreamFrameError("presentation_mismatch", "extension UI requires a rich subscription");
    const requestId = requiredId(frame.requestId, "requestId");
    const response = requiredObject(frame.response, "response");
    this.#launch(frame.correlationId, async () => {
      await this.#authorizeSubscription(id, "control");
      await channel.answerExtensionUi(requestId, response);
      this.#commandResult(id, frame.correlationId, { correlationId: frame.correlationId, state: "completed" });
    });
  }

  #resize(frame: ParsedBase & Record<string, unknown>): void {
    const id = requiredId(frame.subscriptionId, "subscriptionId");
    const channel = this.#requireSubscription(id).channel;
    if (channel.presentation !== "tui") throw new StreamFrameError("presentation_mismatch", "resize requires a TUI subscription");
    const value = dimensions(frame.dimensions, this.#limits);
    this.#launch(frame.correlationId, async () => {
      await this.#authorizeSubscription(id, "read");
      await channel.resize(value);
      this.#commandResult(id, frame.correlationId, { correlationId: frame.correlationId, state: "completed" });
    });
  }

  #input(frame: ParsedBase & Record<string, unknown>): void {
    const id = requiredId(frame.subscriptionId, "subscriptionId");
    const channel = this.#requireSubscription(id).channel;
    if (channel.presentation !== "tui") throw new StreamFrameError("presentation_mismatch", "input requires a TUI subscription");
    if (channel.role !== "controller") throw new StreamFrameError("controller_required", "TUI input requires controller role");
    const input = tuiInput(frame.input);
    this.#launch(frame.correlationId, async () => {
      await this.#authorizeSubscription(id, "control");
      await channel.sendInput(input);
      this.#commandResult(id, frame.correlationId, { correlationId: frame.correlationId, state: "completed" });
    });
  }

  async #authorizeSubscription(
    subscriptionId: string,
    requiredRole: DashboardResourceRole,
  ): Promise<void> {
    const subscription = this.#requireSubscription(subscriptionId);
    try {
      this.#revalidateSession();
      await this.#authorization.require(
        this.#session.principal,
        subscription.authorization,
        requiredRole,
      );
    } catch {
      await this.#closeUnauthorizedSubscription(subscriptionId);
      throw new StreamFrameError(
        "not_found",
        "dashboard resource was not found",
      );
    }
  }

  async #closeUnauthorizedSubscription(subscriptionId: string): Promise<void> {
    const subscription = this.#subscriptions.get(subscriptionId);
    if (subscription === undefined) return;
    this.#subscriptions.delete(subscriptionId);
    subscription.eventQueue.length = 0;
    subscription.unsubscribe();
    await subscription.channel.close().catch(() => undefined);
  }

  #launch(correlationId: string, operation: () => Promise<void>): void {
    if (this.#inFlight.size >= this.#limits.maxInFlightCommandsPerConnection) {
      throw new StreamFrameError("command_capacity", "in-flight command capacity is exhausted", true);
    }
    let pending!: Promise<void>;
    pending = operation()
      .catch((error) => {
        const safe = streamError(error);
        this.#sendError(correlationId, safe.code, safe.message, safe.retryable);
      })
      .finally(() => this.#inFlight.delete(pending));
    this.#inFlight.add(pending);
  }

  #queueAuthorizedEvent(
    subscriptionId: string,
    correlationId: string,
    event: DashboardChannelEvent | DashboardTuiChannelEvent,
  ): void {
    const subscription = this.#subscriptions.get(subscriptionId);
    if (subscription === undefined) return;
    if (subscription.eventQueue.length >= MAX_PENDING_AUTHORIZED_EVENTS_PER_SUBSCRIPTION) {
      void this.#closeUnauthorizedSubscription(subscriptionId);
      return;
    }
    subscription.eventQueue.push({ correlationId, event });
    if (subscription.authorizingEvents) return;
    subscription.authorizingEvents = true;
    void this.#drainAuthorizedEvents(subscriptionId, subscription);
  }

  async #drainAuthorizedEvents(
    subscriptionId: string,
    subscription: Subscription,
  ): Promise<void> {
    try {
      while (
        !this.#closed &&
        this.#subscriptions.get(subscriptionId) === subscription &&
        subscription.eventQueue.length > 0
      ) {
        this.#revalidateSession();
        await this.#authorization.require(
          this.#session.principal,
          subscription.authorization,
          subscription.requiredRole,
        );
        const pending = subscription.eventQueue.shift();
        if (pending !== undefined) {
          this.#sendEvent(
            subscriptionId,
            pending.correlationId,
            subscription.channel,
            pending.event,
          );
        }
      }
    } catch {
      await this.#closeUnauthorizedSubscription(subscriptionId);
    } finally {
      subscription.authorizingEvents = false;
      if (
        !this.#closed &&
        this.#subscriptions.get(subscriptionId) === subscription &&
        subscription.eventQueue.length > 0
      ) {
        subscription.authorizingEvents = true;
        void this.#drainAuthorizedEvents(subscriptionId, subscription);
      }
    }
  }

  #sendEvent(subscriptionId: string, correlationId: string, channel: Channel, event: DashboardChannelEvent | DashboardTuiChannelEvent): void {
    if (event.kind === "replay_gap") {
      this.#send({ ...this.#envelope(correlationId), kind: "replay_gap", subscriptionId, gap: event });
    } else if (event.kind === "tui_delta") {
      if (channel.presentation !== "tui") return this.#fatal();
      this.#send({ ...this.#envelope(correlationId), kind: "tui_delta", subscriptionId, delta: event });
    } else {
      if (channel.presentation !== "rich" && event.kind !== "control") return this.#fatal();
      this.#send({ ...this.#envelope(correlationId), kind: "session_event", subscriptionId, event });
    }
  }

  #commandResult(subscriptionId: string, correlationId: string, result: DashboardCommandResult): void {
    this.#send({ ...this.#envelope(correlationId), kind: "command_result", subscriptionId, result });
  }

  #sendError(correlationId: string, code: string, message: string, retryable = false): void {
    this.#send({ ...this.#envelope(correlationId), kind: "error", error: { code, message, retryable } });
  }

  #send(frame: DashStreamServerFrame): void {
    if (!this.#closed && !this.#peer.send(frame as unknown as Record<string, unknown>)) void this.#closeAll();
  }

  #envelope(correlationId: string) {
    return {
      dashVersion: DASH_API_VERSION,
      requestId: correlationId,
      serverInstanceId: this.#serverInstanceId,
      clientId: this.#session.clientId,
      workspaceId: this.#session.workspaceId,
      correlationId,
    } as const;
  }

  #requireHello(): void {
    if (!this.#helloReceived) throw new StreamFrameError("hello_required", "hello must be sent first");
  }

  #requireSubscription(id: string): Subscription {
    const value = this.#subscriptions.get(id);
    if (value === undefined) throw new StreamFrameError("subscription_not_found", "subscription is not open");
    return value;
  }

  #fatal(): void {
    this.#peer.close(1011, "dashboard stream failed");
    void this.#closeAll();
  }

  async #closeAll(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const subscriptions = [...this.#subscriptions.values()];
    this.#subscriptions.clear();
    for (const subscription of subscriptions) {
      subscription.eventQueue.length = 0;
      subscription.unsubscribe();
    }
    await Promise.allSettled(subscriptions.map((subscription) => subscription.channel.close()));
  }
}

class StreamFrameError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
  }
}

function parseBase(value: unknown, session: DashboardAuthenticatedSession): ParsedBase & Record<string, unknown> {
  const object = requiredObject(value, "frame");
  if (object.dashVersion !== DASH_API_VERSION) throw new StreamFrameError("version_mismatch", "dashboard protocol version is unsupported");
  const clientId = requiredId(object.clientId, "clientId");
  const workspaceId = requiredId(object.workspaceId, "workspaceId");
  if (clientId !== session.clientId || workspaceId !== session.workspaceId) {
    throw new StreamFrameError("identity_mismatch", "dashboard browser identity does not match the authenticated session");
  }
  return {
    ...object,
    dashVersion: DASH_API_VERSION,
    kind: requiredBoundedText(object.kind, "kind", 64),
    clientId,
    workspaceId,
    correlationId: requiredId(object.correlationId, "correlationId"),
  };
}

function dimensions(value: unknown, limits: DashboardStreamRouterOptions["limits"]) {
  const object = requiredObject(value, "dimensions");
  const rows = boundedInteger(object.rows, "rows", 1, limits.maxTuiRows);
  const columns = boundedInteger(object.columns, "columns", 1, limits.maxTuiColumns);
  return { rows, columns };
}

function tuiInput(value: unknown): DashboardTuiInput {
  const object = requiredObject(value, "input");
  const type = requiredEnum(object.type, ["key", "text", "paste"] as const, "input.type");
  if (type === "key") {
    const key = requiredBoundedText(object.key, "input.key", 128);
    if (object.modifiers === undefined) return { type, key };
    if (!Array.isArray(object.modifiers) || object.modifiers.length > 4) throw new StreamFrameError("invalid_frame", "input.modifiers is invalid");
    const modifiers = object.modifiers.map((item) => requiredEnum(item, ["ctrl", "alt", "shift", "meta"] as const, "input.modifier"));
    if (new Set(modifiers).size !== modifiers.length) throw new StreamFrameError("invalid_frame", "input.modifiers is invalid");
    return { type, key, modifiers };
  }
  return { type, text: requiredBoundedText(object.text, "input.text", 65_536) };
}

function assertIdentity(left: DashboardSessionIdentity, right: DashboardSessionIdentity): void {
  if (!sameIdentity(left, right)) throw new StreamFrameError("backend_contract", "backend channel identity is inconsistent");
}
function sameIdentity(left: DashboardSessionIdentity, right: DashboardSessionIdentity): boolean {
  return left.hostInstanceId === right.hostInstanceId && left.sessionId === right.sessionId && left.generation === right.generation;
}
function requiredObject(value: unknown, name: string): JsonObject & Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new StreamFrameError("invalid_frame", `${name} must be an object`);
  return value as JsonObject & Record<string, unknown>;
}
function optionalObject(value: unknown, name: string): JsonObject | undefined {
  return value === undefined ? undefined : requiredObject(value, name);
}
function requiredId(value: unknown, name: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new StreamFrameError("invalid_frame", `${name} is invalid`);
  return value;
}
function boundedId(value: string, name: string): string { return requiredId(value, name); }
function requiredBoundedText(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes || /[\u0000-\u001f\u007f]/.test(value)) throw new StreamFrameError("invalid_frame", `${name} is invalid`);
  return value;
}
function optionalBoundedText(value: unknown, name: string, maxBytes: number): string | undefined {
  return value === undefined ? undefined : requiredBoundedText(value, name, maxBytes);
}
function optionalNonNegativeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new StreamFrameError("invalid_frame", `${name} is invalid`);
  return value as number;
}
function boundedInteger(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new StreamFrameError("invalid_frame", `${name} is invalid`);
  return value as number;
}
function optionalCursor(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new StreamFrameError("invalid_frame", "cursor is invalid");
  try { return asDashboardCursor(value); } catch { throw new StreamFrameError("invalid_frame", "cursor is invalid"); }
}
function requiredEnum<T extends string>(value: unknown, allowed: readonly T[] | Set<T>, name: string): T {
  const present = allowed instanceof Set ? allowed.has(value as T) : allowed.includes(value as T);
  if (typeof value !== "string" || !present) throw new StreamFrameError("invalid_frame", `${name} is invalid`);
  return value as T;
}
function correlationFrom(value: unknown): string {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const candidate = (value as Record<string, unknown>).correlationId;
    if (typeof candidate === "string" && ID.test(candidate)) return candidate;
  }
  return "invalid-frame";
}
function streamError(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof StreamFrameError) return error;
  if (typeof error === "object" && error !== null) {
    const candidate = error as Record<string, unknown>;
    if (typeof candidate.code === "string" && ID.test(candidate.code)) {
      return {
        code: candidate.code,
        message: typeof candidate.message === "string" && Buffer.byteLength(candidate.message, "utf8") <= 1024 ? candidate.message : "dashboard backend request failed",
        retryable: candidate.retryable === true,
      };
    }
  }
  return { code: "backend_error", message: "dashboard backend request failed", retryable: false };
}
