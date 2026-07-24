import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DASH_API_VERSION,
  DASH_DEFAULT_LIMITS,
  DASH_PERFORMANCE_BUDGETS,
  DASH_STREAM_SUBPROTOCOL,
  asDashboardCursor,
} from "@harryaskham/pi-daemon/dashboard-contract";
import type {
  DashStreamClientFrame,
  DashStreamServerFrame,
  DashboardBootstrapResource,
  DashboardCapabilities,
  DashboardChannelSnapshot,
  DashboardSuccessEnvelope,
} from "@harryaskham/pi-daemon/dashboard-contract";
import { BrowserDashboardClient } from "../browser-dashboard-client";

const CLIENT = "browser-test-01";
const WORKSPACE = "workspace-test-01";

function envelope<T>(data: T): DashboardSuccessEnvelope<T> {
  return {
    dashVersion: DASH_API_VERSION,
    requestId: "request-test",
    serverInstanceId: "dash-test-01",
    clientId: CLIENT,
    workspaceId: WORKSPACE,
    ok: true,
    data,
  };
}

const capabilities: DashboardCapabilities = {
  apiVersion: DASH_API_VERSION,
  streamSubprotocol: DASH_STREAM_SUBPROTOCOL,
  sameBrowserProtocolAcrossDeployments: true,
  authentication: { browserSession: "http-only-cookie", csrf: "same-origin-header", daemonBearerExposed: false },
  resources: { inventory: true, transcriptPreview: true, activation: true, export: true, workspaces: true, settings: true, schedules: false, sessionDrafts: true, treeNavigation: false, diagnostics: true },
  presentations: {
    rich: { available: true, replay: true, controller: true, commands: ["prompt"] },
    tui: { available: false, replay: true, controller: true, commands: [], unavailableReason: "test" },
  },
  limits: { ...DASH_DEFAULT_LIMITS },
  performanceBudgets: { ...DASH_PERFORMANCE_BUDGETS },
};

const bootstrap: DashboardBootstrapResource = {
  capabilities,
  settings: {
    revision: 1,
    effective: {
      theme: { name: "nord-midnight", density: "comfortable" },
      editor: { mode: "multiline", submitKey: "enter" },
      sidebar: { initialLimit: 100, showProject: true, groupBy: "none" },
      transcript: { expandTools: false, expandThinking: false },
      motion: { reduced: false },
      cache: { transcriptBytes: 1024, transcriptEntries: 10 },
    },
    runtimeOverlay: {},
    sources: {},
  },
  workspace: {
    workspaceId: WORKSPACE,
    revision: 1,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    selectedPaneId: "primary",
    layout: { type: "leaf", paneId: "primary", content: { type: "empty" } },
    seenCursors: {},
  },
  inventory: {
    sessions: [],
    index: { formatVersion: 1, loadedAt: "2026-07-19T00:00:00.000Z", stale: false, reconciling: false },
  },
};

const snapshot: DashboardChannelSnapshot = {
  identity: { hostInstanceId: "host-test", sessionId: "session-test", generation: 2 },
  session: {
    sessionId: "session-test",
    generation: 2,
    revision: 1,
    residency: "resident",
    state: "idle",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    lastUsedAt: "2026-07-19T00:00:00.000Z",
    spec: { cwd: "/work/test", target: { mode: "memory" }, isolation: { mode: "unisolated" } },
    environment: { keys: [], persistence: "memory-only", provisioned: true },
    links: { self: "/v1/session/session-test", rpc: "/v1/session/session-test/rpc", apc: "/v1/session/session-test/apc" },
  },
  rpcState: {},
  requestState: {},
  entries: [],
  highWaterCursor: asDashboardCursor("cursor-test-1"),
};

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: DashStreamClientFrame[] = [];
  respondToCommands = true;

  constructor() {
    super();
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(text: string): void {
    const frame = JSON.parse(text) as DashStreamClientFrame;
    this.sent.push(frame);
    if (frame.kind === "hello") {
      this.reply({ ...this.base(frame.correlationId), kind: "ready", capabilities });
    } else if (frame.kind === "subscribe") {
      this.reply({
        ...this.base(frame.correlationId),
        kind: "subscription_ready",
        subscriptionId: frame.subscriptionId,
        presentation: "rich",
        role: "controller",
        identity: snapshot.identity,
        highWaterCursor: snapshot.highWaterCursor,
        snapshot,
      });
    } else if (frame.kind === "command" && this.respondToCommands) {
      this.reply({
        ...this.base(frame.correlationId),
        kind: "command_result",
        subscriptionId: frame.subscriptionId,
        result: { correlationId: frame.correlationId, state: frame.operation === "prompt" ? "streaming" : "completed" },
      });
    }
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  emitSettled(subscriptionId: string): void {
    this.reply({
      ...this.base("event-1"),
      kind: "session_event",
      subscriptionId,
      event: {
        kind: "session_event",
        identity: snapshot.identity,
        cursor: asDashboardCursor("cursor-test-2"),
        sequence: 2,
        event: { type: "agent_settled" },
      },
    });
  }

  private base(correlationId: string) {
    return {
      dashVersion: DASH_API_VERSION,
      requestId: correlationId,
      serverInstanceId: "dash-test-01",
      clientId: CLIENT,
      workspaceId: WORKSPACE,
      correlationId,
    } as const;
  }

  private reply(frame: DashStreamServerFrame): void {
    queueMicrotask(() => {
      const event = new Event("message") as Event & { data: string };
      Object.defineProperty(event, "data", { value: JSON.stringify(frame) });
      this.dispatchEvent(event);
    });
  }
}

describe("same-origin browser dashboard client", () => {
  beforeEach(() => {
    vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:7464" });
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  it("exchanges the input-only login credential and applies CSRF to mutations", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
      if (String(url).endsWith("/login")) {
        return new Response(JSON.stringify(envelope({ clientId: CLIENT, workspaceId: WORKSPACE, expiresAt: "2026-07-20T00:00:00.000Z", csrfToken: "csrf-test" })));
      }
      if (String(url).endsWith("/bootstrap")) return new Response(JSON.stringify(envelope(bootstrap)));
      return new Response(JSON.stringify(envelope({
        ticketId: "activation-test",
        requestId: "activate-test",
        idempotencyKey: "activate-key",
        inventoryId: "inventory-test",
        mode: "fork",
        state: "queued",
        submittedAt: "2026-07-19T00:00:00.000Z",
        updatedAt: "2026-07-19T00:00:00.000Z",
      })), { status: 202 });
    });
    const client = new BrowserDashboardClient({ fetch: fetch as typeof globalThis.fetch });
    await client.login("owner-private-credential");
    await client.bootstrap();
    await client.activateSession("inventory-test", {
      requestId: "activate-test",
      idempotencyKey: "activate-key",
      mode: "fork",
    });
    const loginBody = String(calls[0]?.init?.body);
    expect(loginBody).toContain("owner-private-credential");
    expect(calls[2]?.init?.headers).toMatchObject({ "x-pi-daemon-csrf": "csrf-test" });
  });

  it("reads browser-safe diagnostics through the cookie BFF without bearer or mutation headers", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const snapshot = {
      generatedAt: "2026-07-19T00:00:00.000Z",
      status: { instance: "test", configLoaded: true, webConfigured: true, sessionDefaultsConfigured: true, runtimePolicyConfigured: true, installedPackagesConfigured: false, allowedRootCount: 1 },
      events: [],
      limits: { maxEvents: 128, rawLogsExposed: false as const },
    };
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
      if (String(url).endsWith("/login")) return new Response(JSON.stringify(envelope({ clientId: CLIENT, workspaceId: WORKSPACE, expiresAt: "2026-07-20T00:00:00.000Z", csrfToken: "csrf-test" })));
      return new Response(JSON.stringify(envelope(snapshot)));
    });
    const client = new BrowserDashboardClient({ fetch: fetch as typeof globalThis.fetch });
    await client.login("owner-private-credential");
    await expect(client.diagnostics()).resolves.toEqual(snapshot);
    expect(calls[1]?.url).toBe("/dash/v1/diagnostics");
    expect(calls[1]?.init?.method).toBe("GET");
    expect(JSON.stringify(calls[1]?.init?.headers)).not.toMatch(/authorization|bearer|csrf/i);
  });

  it("uses only cookie BFF schedule routes with CSRF, idempotency and exact revision ETags", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const safe = { contractVersion: "1.0", scheduleId: "dash-job", sessionRef: "session-test", revision: 0, enabled: true, cron: "0 9 * * 1-5", timezone: "UTC", overlapPolicy: "skip", missedWakePolicy: { mode: "skip" }, jitterMs: 0, maxAdmissionDelayMs: 1, createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z", promptConfigured: true } as const;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
      if (String(url).endsWith("/login")) return new Response(JSON.stringify(envelope({ clientId: CLIENT, workspaceId: WORKSPACE, expiresAt: "2026-07-20T00:00:00.000Z", csrfToken: "csrf-test" })));
      return new Response(JSON.stringify(envelope(safe)), { status: init?.method === "POST" ? 201 : 200 });
    });
    const client = new BrowserDashboardClient({ fetch: fetch as typeof globalThis.fetch });
    await client.login("owner-private-credential");
    const create = { requestId: "schedule-create", idempotencyKey: "schedule-key", schedule: { scheduleId: "dash-job", sessionRef: "session-test", enabled: true, cron: "0 9 * * 1-5", timezone: "UTC", prompt: "input-only prompt", overlapPolicy: "skip" as const, missedWakePolicy: { mode: "skip" as const }, jitterMs: 0, maxAdmissionDelayMs: 1 } };
    await client.createSchedule(create);
    const { prompt: _prompt, ...scheduleWithoutPrompt } = create.schedule;
    await client.updateSchedule("dash-job", { ...create, requestId: "schedule-update", idempotencyKey: "schedule-update-key", expectedRevision: 0, schedule: scheduleWithoutPrompt });
    expect(calls[1]?.url).toBe("/dash/v1/schedules");
    expect(calls[1]?.init?.headers).toMatchObject({ "x-pi-daemon-csrf": "csrf-test", "Idempotency-Key": "schedule-key", "X-Request-ID": "schedule-create" });
    expect(calls[2]?.url).toBe("/dash/v1/schedules/dash-job");
    expect(calls[2]?.init?.headers).toMatchObject({ "If-Match": '"ZGFzaC1qb2I:0"' });
    expect(JSON.stringify(calls.map((call) => call.init?.headers))).not.toMatch(/authorization|bearer/i);
  });

  it("uses CSRF, exact policy/controller ETags and no bearer for authorization administration", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const policy = {
      resource: { kind: "session" as const, id: "managed:session-test" },
      ownerIdentityId: "owner-test",
      grants: [],
      revision: 3,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
    };
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
      if (String(url).endsWith("/login")) return new Response(JSON.stringify(envelope({ clientId: CLIENT, workspaceId: WORKSPACE, expiresAt: "2026-07-20T00:00:00.000Z", csrfToken: "csrf-test" })));
      return new Response(JSON.stringify(envelope({ policy: { ...policy, revision: 4 }, role: "admin" })));
    });
    const client = new BrowserDashboardClient({ fetch: fetch as typeof globalThis.fetch });
    await client.login("owner-private-credential");
    await client.setAuthorizationGrant("session", "inventory-test", "operator-test", policy, {
      requestId: "grant-test",
      idempotencyKey: "grant-test-key",
      expectedRevision: 3,
      role: "control",
    });
    expect(calls[1]?.url).toBe("/dash/v1/authorization/session/inventory-test/grants/operator-test");
    expect(calls[1]?.init?.headers).toMatchObject({
      "x-pi-daemon-csrf": "csrf-test",
      "If-Match": '"dashboard-authorization:session:managed:session-test:3"',
      "Idempotency-Key": "grant-test-key",
      "X-Request-ID": "grant-test",
    });
    expect(Object.keys(calls[1]?.init?.headers ?? {})).not.toContain("Authorization");
    expect(JSON.stringify(calls[1]?.init?.headers)).not.toMatch(/bearer/i);
  });

  it("uses only cookie BFF draft routes with CSRF, idempotency and exact draft ETags", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const spec = {
      cwd: "/work/test",
      persistence: "persistent" as const,
      tools: { mode: "none" as const },
      resources: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, projectTrust: "deny" as const },
      isolation: { mode: "unisolated" as const },
    };
    const draft = { contractVersion: "1.0" as const, draftId: "draft-browser-01", revision: 1, state: "draft" as const, createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z", spec, firstMessageStartsSession: true as const };
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
      if (String(url).endsWith("/login")) return new Response(JSON.stringify(envelope({ clientId: CLIENT, workspaceId: WORKSPACE, expiresAt: "2026-07-20T00:00:00.000Z", csrfToken: "csrf-test" })));
      if (String(url).endsWith("/send")) return new Response(JSON.stringify(envelope({ ticketId: "draft-send-01", draftId: draft.draftId, draftRevision: 1, requestId: "draft-send", idempotencyKey: "draft-send-key", state: "queued", submittedAt: draft.createdAt, updatedAt: draft.updatedAt })), { status: 202 });
      return new Response(JSON.stringify(envelope(draft)), { status: init?.method === "POST" ? 201 : 200 });
    });
    const client = new BrowserDashboardClient({ fetch: fetch as typeof globalThis.fetch });
    await client.login("owner-private-credential");
    await client.createSessionDraft({ requestId: "draft-create", idempotencyKey: "draft-create-key", draftId: draft.draftId, spec });
    await client.sendSessionDraft(draft.draftId, { requestId: "draft-send", idempotencyKey: "draft-send-key", expectedRevision: 1, message: "start once" });
    await client.cancelSessionDraft(draft.draftId, { requestId: "draft-cancel", idempotencyKey: "draft-cancel-key", expectedRevision: 1 });
    expect(calls[1]?.url).toBe("/dash/v1/session-drafts");
    expect(calls[1]?.init?.headers).toMatchObject({ "x-pi-daemon-csrf": "csrf-test", "Idempotency-Key": "draft-create-key" });
    expect(calls[2]?.url).toBe("/dash/v1/session-drafts/draft-browser-01/send");
    expect(calls[2]?.init?.headers).toMatchObject({ "If-Match": '"ZHJhZnQtYnJvd3Nlci0wMQ:1"' });
    expect(calls[3]?.init?.headers).toMatchObject({ "If-Match": '"ZHJhZnQtYnJvd3Nlci0wMQ:1"' });
    expect(JSON.stringify(calls.map((call) => call.init?.headers))).not.toMatch(/authorization|bearer/i);
  });

  it("resumes mutation authority from an authenticated bootstrap after reload", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.endsWith("/bootstrap")) {
        return new Response(JSON.stringify(envelope(bootstrap)), {
          headers: { "x-pi-daemon-csrf": "r".repeat(43) },
        });
      }
      return new Response(JSON.stringify(envelope(bootstrap.settings)));
    });
    const client = new BrowserDashboardClient({ fetch: fetch as typeof globalThis.fetch });
    await client.bootstrap();
    expect(client.authenticatedForMutations).toBe(true);
    await client.patchSettings({
      requestId: "settings-after-reload",
      idempotencyKey: "settings-after-reload-key",
      expectedRevision: bootstrap.settings.revision,
      patch: { motion: { reduced: true } },
    });
    expect(calls[1]?.init?.headers).toMatchObject({ "x-pi-daemon-csrf": "r".repeat(43) });
  });

  it("negotiates one multiplexed stream and exposes rich events and commands", async () => {
    let socket: FakeWebSocket | undefined;
    const fetch = vi.fn(async () => new Response(JSON.stringify(envelope(bootstrap))));
    const client = new BrowserDashboardClient({
      fetch: fetch as typeof globalThis.fetch,
      webSocket: () => {
        socket = new FakeWebSocket();
        return socket as unknown as WebSocket;
      },
    });
    await client.bootstrap();
    const channel = await client.openSessionChannel({ sessionRef: "session-test", generation: 2, role: "controller" });
    if (socket === undefined) throw new Error("stream socket was not created");
    expect(channel.identity).toEqual(snapshot.identity);
    expect(channel.role).toBe("controller");
    const events: string[] = [];
    channel.subscribe((event) => events.push(event.kind));
    socket.emitSettled((socket.sent.find((frame) => frame.kind === "subscribe") as Extract<DashStreamClientFrame, { kind: "subscribe" }>).subscriptionId);
    await Promise.resolve();
    expect(events).toEqual(["session_event"]);
    const result = await channel.command({
      correlationId: "prompt-test",
      identity: channel.identity,
      operation: "prompt",
      payload: { message: "hello" },
    });
    expect(result.state).toBe("streaming");
    expect(socket.sent.filter((frame) => frame.kind === "hello")).toHaveLength(1);

    socket.respondToCommands = false;
    const acceptedWithoutReply = channel.command({ correlationId: "lost-command", identity: channel.identity, operation: "set_session_name", payload: { name: "lost" } });
    await vi.waitFor(() => expect(socket?.sent.some((frame) => frame.kind === "command" && frame.correlationId === "lost-command")).toBe(true));
    socket.close();
    expect(await acceptedWithoutReply).toMatchObject({ state: "indeterminate", error: { code: "stream_disconnected" } });
    await channel.close();
  });
});
