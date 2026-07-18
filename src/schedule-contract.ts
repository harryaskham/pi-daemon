export const SCHEDULE_CONTRACT_VERSION = "1.0" as const;
export const SCHEDULE_STORE_FORMAT_VERSION = 1 as const;

export interface ScheduleLimits {
  maxSchedules: number;
  maxSchedulesPerSession: number;
  maxPromptBytes: number;
  maxRecordBytes: number;
  maxRecoveryBytes: number;
  maxCatchUpRuns: number;
  maxJitterMs: number;
  maxAdmissionDelayMs: number;
}

export const DEFAULT_SCHEDULE_LIMITS = Object.freeze({
  maxSchedules: 1_024,
  maxSchedulesPerSession: 32,
  maxPromptBytes: 65_536,
  maxRecordBytes: 131_072,
  maxRecoveryBytes: 134_217_728,
  maxCatchUpRuns: 24,
  maxJitterMs: 86_400_000,
  maxAdmissionDelayMs: 86_400_000,
}) satisfies Readonly<ScheduleLimits>;

export type ScheduleThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ScheduleOverlapPolicy = "skip" | "queue-one" | "reject";
export type ScheduleMissedWakePolicy =
  | { mode: "skip" }
  | { mode: "run-once" }
  | { mode: "bounded-catch-up"; maxRuns: number };

export interface ScheduleExecutionOverride {
  model?: { provider: string; id: string };
  thinkingLevel?: ScheduleThinkingLevel;
}

/** Deliberately content-free: terminal ticket summaries are safe for logs and listings. */
export interface ScheduleTerminalTicketSummary {
  ticketId: string;
  state: "completed" | "failed" | "indeterminate";
  updatedAt: string;
  errorCode?: string;
}

export interface ScheduleLastTrigger {
  scheduledFor: string;
  observedAt: string;
  disposition: "admitted" | "skipped" | "rejected";
  terminalTicket?: ScheduleTerminalTicketSummary;
}

export interface ScheduleResource {
  contractVersion: typeof SCHEDULE_CONTRACT_VERSION;
  scheduleId: string;
  sessionRef: string;
  revision: number;
  enabled: boolean;
  cron: string;
  timezone: string;
  prompt: string;
  execution?: ScheduleExecutionOverride;
  overlapPolicy: ScheduleOverlapPolicy;
  missedWakePolicy: ScheduleMissedWakePolicy;
  jitterMs: number;
  maxAdmissionDelayMs: number;
  nextTriggerAt?: string;
  lastTrigger?: ScheduleLastTrigger;
  createdAt: string;
  updatedAt: string;
}

export type SchedulePut = Omit<ScheduleResource, "contractVersion" | "revision" | "createdAt" | "updatedAt" | "lastTrigger"> & {
  expectedRevision?: number;
  lastTrigger?: ScheduleLastTrigger;
};

export interface ScheduleCapabilities {
  contractVersion: typeof SCHEDULE_CONTRACT_VERSION;
  persistence: true;
  timerRuntime: false;
  cronSyntax: "posix-five-field";
  timezoneDatabase: "runtime-iana";
  optimisticConcurrency: "expected-revision";
  overlapPolicies: readonly ScheduleOverlapPolicy[];
  missedWakePolicies: readonly ScheduleMissedWakePolicy["mode"][];
  promptHandling: "owner-private-sensitive-content";
  terminalTicketSummary: "content-free";
  clock: "wall-clock-utc-instants";
  limits: ScheduleLimits;
}

export function scheduleCapabilities(limits: Partial<ScheduleLimits> = {}): ScheduleCapabilities {
  return {
    contractVersion: SCHEDULE_CONTRACT_VERSION,
    persistence: true,
    timerRuntime: false,
    cronSyntax: "posix-five-field",
    timezoneDatabase: "runtime-iana",
    optimisticConcurrency: "expected-revision",
    overlapPolicies: ["skip", "queue-one", "reject"],
    missedWakePolicies: ["skip", "run-once", "bounded-catch-up"],
    promptHandling: "owner-private-sensitive-content",
    terminalTicketSummary: "content-free",
    clock: "wall-clock-utc-instants",
    limits: resolveScheduleLimits(limits),
  };
}

export class ScheduleValidationError extends Error {
  readonly code: "invalid_schedule" | "schedule_too_large";
  constructor(code: ScheduleValidationError["code"], message: string) {
    super(message);
    this.name = "ScheduleValidationError";
    this.code = code;
  }
}

export function resolveScheduleLimits(overrides: Partial<ScheduleLimits> = {}): ScheduleLimits {
  const result = { ...DEFAULT_SCHEDULE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  }
  return result;
}

export function validateCronExpression(value: string): string {
  if (typeof value !== "string" || value.length < 9 || value.length > 256 || /[\r\n\t]/u.test(value)) {
    invalid("cron must be a bounded five-field expression");
  }
  const fields = value.trim().split(/ +/u);
  if (fields.length !== 5) invalid("cron must contain minute, hour, day-of-month, month and day-of-week");
  const ranges: ReadonlyArray<readonly [number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  fields.forEach((field, index) => validateCronField(field!, ranges[index]![0], ranges[index]![1]));
  return fields.join(" ");
}

function validateCronField(field: string, min: number, max: number): void {
  if (!/^[0-9*/,-]+$/u.test(field)) invalid("cron fields support only numbers, *, lists, ranges and steps");
  for (const item of field.split(",")) {
    const pieces = item.split("/");
    if (pieces.length > 2 || pieces.some((piece) => piece.length === 0)) invalid("invalid cron step");
    if (pieces[1] !== undefined) {
      const step = Number(pieces[1]);
      if (!Number.isSafeInteger(step) || step < 1 || step > max - min + 1) invalid("cron step is out of range");
    }
    const base = pieces[0]!;
    if (base === "*") continue;
    const endpoints = base.split("-");
    if (endpoints.length > 2) invalid("invalid cron range");
    const values = endpoints.map(Number);
    if (values.some((number) => !Number.isSafeInteger(number) || number < min || number > max)) invalid("cron value is out of range");
    if (values.length === 2 && values[0]! > values[1]!) invalid("cron range must be ascending");
  }
}

export function validateIanaTimezone(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)*$/u.test(value)) {
    invalid("timezone must be an IANA timezone name");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
  } catch {
    invalid("timezone is not available in the runtime IANA database");
  }
  return value;
}

export function validateScheduleResource(value: unknown, limits: Partial<ScheduleLimits> = {}): ScheduleResource {
  const resolved = resolveScheduleLimits(limits);
  const object = record(value);
  exactKeys(object, ["contractVersion", "scheduleId", "sessionRef", "revision", "enabled", "cron", "timezone", "prompt", "execution", "overlapPolicy", "missedWakePolicy", "jitterMs", "maxAdmissionDelayMs", "nextTriggerAt", "lastTrigger", "createdAt", "updatedAt"]);
  if (object.contractVersion !== SCHEDULE_CONTRACT_VERSION) invalid("unsupported schedule contract version");
  const resource: ScheduleResource = {
    contractVersion: SCHEDULE_CONTRACT_VERSION,
    scheduleId: identifier(object.scheduleId, "scheduleId"),
    sessionRef: identifier(object.sessionRef, "sessionRef", 256),
    revision: integer(object.revision, "revision", 0, Number.MAX_SAFE_INTEGER),
    enabled: boolean(object.enabled, "enabled"),
    cron: validateCronExpression(object.cron as string),
    timezone: validateIanaTimezone(object.timezone as string),
    prompt: prompt(object.prompt, resolved),
    overlapPolicy: enumeration(object.overlapPolicy, "overlapPolicy", ["skip", "queue-one", "reject"]),
    missedWakePolicy: missedWake(object.missedWakePolicy, resolved),
    jitterMs: integer(object.jitterMs, "jitterMs", 0, resolved.maxJitterMs),
    maxAdmissionDelayMs: integer(object.maxAdmissionDelayMs, "maxAdmissionDelayMs", 0, resolved.maxAdmissionDelayMs),
    createdAt: timestamp(object.createdAt, "createdAt"),
    updatedAt: timestamp(object.updatedAt, "updatedAt"),
  };
  if (object.execution !== undefined) resource.execution = execution(object.execution);
  if (object.nextTriggerAt !== undefined) resource.nextTriggerAt = timestamp(object.nextTriggerAt, "nextTriggerAt");
  if (object.lastTrigger !== undefined) resource.lastTrigger = lastTrigger(object.lastTrigger);
  if (Buffer.byteLength(JSON.stringify(resource), "utf8") + 1 > resolved.maxRecordBytes) throw new ScheduleValidationError("schedule_too_large", "schedule record exceeds maxRecordBytes");
  return resource;
}

function execution(value: unknown): ScheduleExecutionOverride {
  const object = record(value); exactKeys(object, ["model", "thinkingLevel"]);
  if (object.model === undefined && object.thinkingLevel === undefined) invalid("execution override must not be empty");
  const result: ScheduleExecutionOverride = {};
  if (object.model !== undefined) { const model = record(object.model); exactKeys(model, ["provider", "id"]); result.model = { provider: text(model.provider, "model.provider", 128), id: text(model.id, "model.id", 256) }; }
  if (object.thinkingLevel !== undefined) result.thinkingLevel = enumeration(object.thinkingLevel, "thinkingLevel", ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  return result;
}

function missedWake(value: unknown, limits: ScheduleLimits): ScheduleMissedWakePolicy {
  const object = record(value); exactKeys(object, ["mode", "maxRuns"]);
  const mode = enumeration(object.mode, "missedWakePolicy.mode", ["skip", "run-once", "bounded-catch-up"]);
  if (mode === "bounded-catch-up") return { mode, maxRuns: integer(object.maxRuns, "maxRuns", 1, limits.maxCatchUpRuns) };
  if (object.maxRuns !== undefined) invalid("maxRuns is only valid for bounded-catch-up");
  return { mode };
}

function lastTrigger(value: unknown): ScheduleLastTrigger {
  const object = record(value); exactKeys(object, ["scheduledFor", "observedAt", "disposition", "terminalTicket"]);
  const result: ScheduleLastTrigger = { scheduledFor: timestamp(object.scheduledFor, "scheduledFor"), observedAt: timestamp(object.observedAt, "observedAt"), disposition: enumeration(object.disposition, "disposition", ["admitted", "skipped", "rejected"]) };
  if (object.terminalTicket !== undefined) {
    if (result.disposition !== "admitted") invalid("only an admitted trigger may have a terminal ticket");
    const ticket = record(object.terminalTicket); exactKeys(ticket, ["ticketId", "state", "updatedAt", "errorCode"]);
    result.terminalTicket = { ticketId: identifier(ticket.ticketId, "ticketId", 256), state: enumeration(ticket.state, "ticket state", ["completed", "failed", "indeterminate"]), updatedAt: timestamp(ticket.updatedAt, "ticket updatedAt") };
    if (ticket.errorCode !== undefined) result.terminalTicket.errorCode = identifier(ticket.errorCode, "errorCode", 128);
  }
  return result;
}

function prompt(value: unknown, limits: ScheduleLimits): string { if (typeof value !== "string" || value.length < 1 || value.includes("\0")) invalid("prompt must be a non-empty bounded string"); if (Buffer.byteLength(value, "utf8") > limits.maxPromptBytes) throw new ScheduleValidationError("schedule_too_large", "prompt exceeds maxPromptBytes"); return value; }
function record(value: unknown): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("schedule value must be an object"); return value as Record<string, unknown>; }
function exactKeys(object: Record<string, unknown>, allowed: string[]): void { const set = new Set(allowed); if (Object.keys(object).some((key) => !set.has(key))) invalid("schedule contains an unknown field"); }
function identifier(value: unknown, name: string, max = 128): string { const result = text(value, name, max); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result)) invalid(`${name} is not a valid identifier`); return result; }
function text(value: unknown, name: string, max: number): string { if (typeof value !== "string" || value.length < 1 || value.length > max || value.includes("\0")) invalid(`${name} must be a non-empty bounded string`); return value; }
function integer(value: unknown, name: string, min: number, max: number): number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) invalid(`${name} is out of range`); return value as number; }
function boolean(value: unknown, name: string): boolean { if (typeof value !== "boolean") invalid(`${name} must be boolean`); return value; }
function timestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) invalid(`${name} must be a UTC RFC 3339 instant`);
  const canonical = new Date(value).toISOString();
  if (canonical !== value && !(value.endsWith("Z") && canonical === `${value.slice(0, -1)}.000Z`)) invalid(`${name} must be a real calendar instant`);
  return value;
}
function enumeration<T extends string>(value: unknown, name: string, allowed: readonly T[]): T { if (typeof value !== "string" || !allowed.includes(value as T)) invalid(`${name} is invalid`); return value as T; }
function invalid(message: string): never { throw new ScheduleValidationError("invalid_schedule", message); }
