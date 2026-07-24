import type { LoadedPiDaemonConfig } from "./config.js";

export const DASHBOARD_DIAGNOSTICS_MAX_EVENTS = 128;

export type DashboardDiagnosticLevel = "info" | "warning" | "error";
export type DashboardDiagnosticSource = "daemon" | "api" | "web";

export interface DashboardDiagnosticEvent {
  sequence: number;
  timestamp: string;
  level: DashboardDiagnosticLevel;
  source: DashboardDiagnosticSource;
  code: string;
  message: string;
  route?: string;
  status?: number;
}

export interface DashboardDiagnosticStatus {
  instance: string;
  configLoaded: boolean;
  webConfigured: boolean;
  sessionDefaultsConfigured: boolean;
  runtimePolicyConfigured: boolean;
  installedPackagesConfigured: boolean;
  allowedRootCount: number;
}

export interface DashboardDiagnosticsSnapshot {
  generatedAt: string;
  status: DashboardDiagnosticStatus;
  events: DashboardDiagnosticEvent[];
  limits: {
    maxEvents: number;
    rawLogsExposed: false;
  };
}

export interface DashboardApiFailure {
  method: string | undefined;
  path: string;
  status: number;
  code: string;
}

export interface DashboardDiagnosticsServiceOptions {
  loadedConfig: LoadedPiDaemonConfig;
  allowedRootCount: number;
  maxEvents?: number;
  now?: () => Date;
}

/**
 * Bounded, browser-safe service diagnostics. The ring deliberately records
 * only allowlisted metadata and normalized routes. Raw log lines, request
 * bodies, prompts, model output, paths, credentials, and environment values
 * never enter this store.
 */
export class DashboardDiagnosticsService {
  readonly #status: DashboardDiagnosticStatus;
  readonly #maxEvents: number;
  readonly #now: () => Date;
  readonly #events: DashboardDiagnosticEvent[] = [];
  #sequence = 0;

  constructor(options: DashboardDiagnosticsServiceOptions) {
    this.#maxEvents = positiveInteger(
      options.maxEvents ?? DASHBOARD_DIAGNOSTICS_MAX_EVENTS,
      "maxEvents",
    );
    this.#now = options.now ?? (() => new Date());
    const web = options.loadedConfig.config.web;
    this.#status = {
      instance: options.loadedConfig.instance,
      configLoaded: options.loadedConfig.present,
      webConfigured: web !== undefined,
      sessionDefaultsConfigured: web?.sessionDefaults !== undefined,
      runtimePolicyConfigured: web?.runtimePolicy !== undefined,
      installedPackagesConfigured: web?.runtimePolicy?.resources?.inheritInstalledPackages === true,
      allowedRootCount: options.allowedRootCount,
    };
    this.record({
      level: "info",
      source: "daemon",
      code: "dashboard_runtime_ready",
      message: "Dashboard policy runtime is ready.",
    });
  }

  recordApiFailure(failure: DashboardApiFailure): void {
    if (!failure.path.startsWith("/v1/dashboard/") && !failure.path.startsWith("/dash/v1/")) return;
    if (["/v1/dashboard/diagnostics", "/dash/v1/diagnostics"].includes(failure.path)) return;
    this.record({
      level: failure.status >= 500 ? "error" : "warning",
      source: "api",
      code: safeCode(failure.code),
      message: diagnosticMessage(failure.code),
      route: normalizedDashboardRoute(failure.method, failure.path),
      status: safeStatus(failure.status),
    });
  }

  record(event: Omit<DashboardDiagnosticEvent, "sequence" | "timestamp">): void {
    const next: DashboardDiagnosticEvent = {
      sequence: ++this.#sequence,
      timestamp: this.#now().toISOString(),
      level: event.level,
      source: event.source,
      code: safeCode(event.code),
      message: safeMessage(event.message),
      ...(event.route === undefined ? {} : { route: safeRoute(event.route) }),
      ...(event.status === undefined ? {} : { status: safeStatus(event.status) }),
    };
    this.#events.push(next);
    if (this.#events.length > this.#maxEvents) {
      this.#events.splice(0, this.#events.length - this.#maxEvents);
    }
  }

  snapshot(): DashboardDiagnosticsSnapshot {
    return {
      generatedAt: this.#now().toISOString(),
      status: structuredClone(this.#status),
      events: structuredClone(this.#events),
      limits: { maxEvents: this.#maxEvents, rawLogsExposed: false },
    };
  }
}

function diagnosticMessage(code: string): string {
  switch (code) {
    case "draft_cwd_not_allowed":
      return "The requested session working directory is outside the configured allowed roots.";
    case "draft_authority_denied":
      return "The requested session authority exceeds the configured owner policy.";
    case "invalid_session_draft":
      return "The new-session draft did not satisfy the service contract.";
    case "remote_unavailable":
      return "The remote daemon service is unavailable.";
    case "request_timeout":
      return "The dashboard request timed out.";
    default:
      return "The dashboard request was rejected at the service boundary.";
  }
}

function normalizedDashboardRoute(method: string | undefined, path: string): string {
  const verb = typeof method === "string" && /^[A-Z]{3,8}$/.test(method) ? method : "REQUEST";
  const templates: Array<[RegExp, string]> = [
    [/^\/v1\/dashboard\/capabilities$/, "/v1/dashboard/capabilities"],
    [/^\/v1\/dashboard\/inventory$/, "/v1/dashboard/inventory"],
    [/^\/v1\/dashboard\/inventory\/[^/]+\/transcript$/, "/v1/dashboard/inventory/:id/transcript"],
    [/^\/v1\/dashboard\/inventory\/[^/]+\/activate$/, "/v1/dashboard/inventory/:id/activate"],
    [/^\/v1\/dashboard\/inventory\/[^/]+$/, "/v1/dashboard/inventory/:id"],
    [/^\/v1\/dashboard\/activation\/[^/]+$/, "/v1/dashboard/activation/:id"],
    [/^\/v1\/dashboard\/export\/[^/]+$/, "/v1/dashboard/export/:id"],
    [/^\/v1\/dashboard\/session\/[^/]+\/(?:export|lease)$/, "/v1/dashboard/session/:id/action"],
    [/^\/v1\/dashboard\/session-drafts$/, "/v1/dashboard/session-drafts"],
    [/^\/v1\/dashboard\/session-drafts\/[^/]+\/send$/, "/v1/dashboard/session-drafts/:id/send"],
    [/^\/v1\/dashboard\/session-drafts\/[^/]+$/, "/v1/dashboard/session-drafts/:id"],
    [/^\/v1\/dashboard\/session-draft-send\/[^/]+$/, "/v1/dashboard/session-draft-send/:id"],
    [/^\/dash\/v1\/sessions$/, "/dash/v1/sessions"],
    [/^\/dash\/v1\/sessions\/[^/]+\/transcript$/, "/dash/v1/sessions/:id/transcript"],
    [/^\/dash\/v1\/sessions\/[^/]+\/activate$/, "/dash/v1/sessions/:id/activate"],
    [/^\/dash\/v1\/sessions\/[^/]+\/export$/, "/dash/v1/sessions/:id/export"],
    [/^\/dash\/v1\/sessions\/[^/]+$/, "/dash/v1/sessions/:id"],
    [/^\/dash\/v1\/session-drafts$/, "/dash/v1/session-drafts"],
    [/^\/dash\/v1\/session-drafts\/[^/]+\/send$/, "/dash/v1/session-drafts/:id/send"],
    [/^\/dash\/v1\/session-drafts\/[^/]+$/, "/dash/v1/session-drafts/:id"],
    [/^\/dash\/v1\/session-draft-send\/[^/]+$/, "/dash/v1/session-draft-send/:id"],
  ];
  const route = templates.find(([pattern]) => pattern.test(path))?.[1] ?? "/v1/dashboard/:route";
  return `${verb} ${route}`;
}

function safeCode(value: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : "dashboard_error";
}

function safeMessage(value: string): string {
  if (value.length === 0 || value.length > 256 || /[\r\n\u0000]/u.test(value)) {
    return "Dashboard diagnostic event.";
  }
  return value;
}

function safeRoute(value: string): string {
  if (value.length === 0 || value.length > 256 || !/^[A-Z]+ \/[A-Za-z0-9_/:.-]*$/.test(value)) {
    return "REQUEST /v1/dashboard/:route";
  }
  return value;
}

function safeStatus(value: number): number {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : 500;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
