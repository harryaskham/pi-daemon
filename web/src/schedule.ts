import type {
  DashboardBackend,
  DashboardScheduleMutationRequest,
  DashboardScheduleResource,
  DashboardScheduleWrite,
} from "@harryaskham/pi-daemon/dashboard-contract";
import type {
  ScheduleCapabilities,
  ScheduleMissedWakePolicy,
  ScheduleOverlapPolicy,
  ScheduleThinkingLevel,
} from "@harryaskham/pi-daemon/schedule-contract";

export type { ScheduleCapabilities, DashboardScheduleResource as ScheduleResource };

export interface ScheduleDraft {
  scheduleId: string;
  sessionRef: string;
  enabled: boolean;
  cron: string;
  timezone: string;
  prompt: string;
  promptConfigured: boolean;
  modelProvider: string;
  modelId: string;
  thinkingLevel: "inherit" | ScheduleThinkingLevel;
  overlapPolicy: ScheduleOverlapPolicy;
  missedWakeMode: ScheduleMissedWakePolicy["mode"];
  maxCatchUpRuns: number;
  jitterSeconds: number;
  maxAdmissionDelaySeconds: number;
}

export type ScheduleBackend = Pick<DashboardBackend,
  "scheduleCapabilities" | "listSchedules" | "createSchedule" | "updateSchedule" | "deleteSchedule"
>;

export function hasScheduleBackend(value: unknown): value is ScheduleBackend {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<ScheduleBackend>;
  return ["scheduleCapabilities", "listSchedules", "createSchedule", "updateSchedule", "deleteSchedule"]
    .every((name) => typeof candidate[name as keyof ScheduleBackend] === "function");
}

export function draftFromSchedule(resource: DashboardScheduleResource): ScheduleDraft {
  return {
    scheduleId: resource.scheduleId,
    sessionRef: resource.sessionRef,
    enabled: resource.enabled,
    cron: resource.cron,
    timezone: resource.timezone,
    prompt: "",
    promptConfigured: resource.promptConfigured,
    modelProvider: resource.execution?.model?.provider ?? "",
    modelId: resource.execution?.model?.id ?? "",
    thinkingLevel: resource.execution?.thinkingLevel ?? "inherit",
    overlapPolicy: resource.overlapPolicy,
    missedWakeMode: resource.missedWakePolicy.mode,
    maxCatchUpRuns: resource.missedWakePolicy.mode === "bounded-catch-up" ? resource.missedWakePolicy.maxRuns : 1,
    jitterSeconds: Math.floor(resource.jitterMs / 1_000),
    maxAdmissionDelaySeconds: Math.floor(resource.maxAdmissionDelayMs / 1_000),
  };
}

export function newScheduleDraft(sessionRef: string): ScheduleDraft {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return {
    scheduleId: `schedule-${crypto.randomUUID()}`,
    sessionRef,
    enabled: true,
    cron: "0 9 * * 1-5",
    timezone,
    prompt: "",
    promptConfigured: false,
    modelProvider: "",
    modelId: "",
    thinkingLevel: "inherit",
    overlapPolicy: "skip",
    missedWakeMode: "skip",
    maxCatchUpRuns: 1,
    jitterSeconds: 0,
    maxAdmissionDelaySeconds: 300,
  };
}

export function scheduleMutation(draft: ScheduleDraft, expectedRevision?: number): DashboardScheduleMutationRequest {
  const idempotencyKey = `dash-schedule-${draft.scheduleId}-${crypto.randomUUID()}`;
  return {
    requestId: idempotencyKey,
    idempotencyKey,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    schedule: scheduleWrite(draft),
  };
}

export function scheduleWrite(draft: ScheduleDraft): DashboardScheduleWrite {
  const hasModel = draft.modelProvider.length > 0 && draft.modelId.length > 0;
  const hasThinking = draft.thinkingLevel !== "inherit";
  return {
    scheduleId: draft.scheduleId,
    sessionRef: draft.sessionRef,
    enabled: draft.enabled,
    cron: draft.cron,
    timezone: draft.timezone,
    ...(!draft.promptConfigured || draft.prompt.length > 0 ? { prompt: draft.prompt } : {}),
    ...(hasModel || hasThinking ? { execution: {
      ...(hasModel ? { model: { provider: draft.modelProvider, id: draft.modelId } } : {}),
      ...(hasThinking ? { thinkingLevel: draft.thinkingLevel as ScheduleThinkingLevel } : {}),
    } } : {}),
    overlapPolicy: draft.overlapPolicy,
    missedWakePolicy: draft.missedWakeMode === "bounded-catch-up" ? { mode: draft.missedWakeMode, maxRuns: draft.maxCatchUpRuns } : { mode: draft.missedWakeMode },
    jitterMs: draft.jitterSeconds * 1_000,
    maxAdmissionDelayMs: draft.maxAdmissionDelaySeconds * 1_000,
  };
}

export function validateScheduleDraft(draft: ScheduleDraft, capabilities: ScheduleCapabilities): Record<string, string> {
  const errors: Record<string, string> = {};
  const fields = draft.cron.trim().split(/ +/u);
  if (fields.length !== 5) errors.cron = "Use five fields: minute, hour, day, month, weekday.";
  else {
    const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
    if (fields.some((field, index) => {
      const range = ranges[index]!;
      return !validCronField(field, range[0], range[1]);
    })) errors.cron = "A cron field is invalid or outside its allowed range.";
  }
  try { new Intl.DateTimeFormat(undefined, { timeZone: draft.timezone }).format(); }
  catch { errors.timezone = "Choose an IANA timezone available on this daemon."; }
  if (!draft.promptConfigured && draft.prompt.trim().length === 0) errors.prompt = "Add the prompt to submit at wake time.";
  if (new TextEncoder().encode(draft.prompt).byteLength > capabilities.limits.maxPromptBytes) errors.prompt = `Prompt exceeds ${capabilities.limits.maxPromptBytes.toLocaleString()} bytes.`;
  if ((draft.modelProvider.length === 0) !== (draft.modelId.length === 0)) errors.model = "Provider and model ID must be set together.";
  if (!Number.isInteger(draft.jitterSeconds) || draft.jitterSeconds < 0 || draft.jitterSeconds * 1_000 > capabilities.limits.maxJitterMs) errors.jitter = "Jitter is outside the negotiated limit.";
  if (!Number.isInteger(draft.maxAdmissionDelaySeconds) || draft.maxAdmissionDelaySeconds < 0 || draft.maxAdmissionDelaySeconds * 1_000 > capabilities.limits.maxAdmissionDelayMs) errors.delay = "Admission delay is outside the negotiated limit.";
  if (draft.missedWakeMode === "bounded-catch-up" && (!Number.isInteger(draft.maxCatchUpRuns) || draft.maxCatchUpRuns < 1 || draft.maxCatchUpRuns > capabilities.limits.maxCatchUpRuns)) errors.catchUp = `Choose 1–${capabilities.limits.maxCatchUpRuns} catch-up runs.`;
  return errors;
}

function validCronField(field: string, minimum: number, maximum: number): boolean {
  if (!/^[0-9*/,-]+$/u.test(field)) return false;
  return field.split(",").every((item) => {
    const [base, step, extra] = item.split("/");
    if (base === undefined || extra !== undefined || (step !== undefined && (!/^\d+$/u.test(step) || Number(step) < 1 || Number(step) > maximum - minimum + 1))) return false;
    if (base === "*") return true;
    const endpoints = base.split("-");
    if (endpoints.length > 2 || endpoints.some((value) => !/^\d+$/u.test(value))) return false;
    const numbers = endpoints.map(Number);
    return numbers.every((value) => value >= minimum && value <= maximum) && (numbers.length === 1 || numbers[0]! <= numbers[1]!);
  });
}

export function cronHumanPreview(cron: string): string {
  const fields = cron.trim().split(/ +/u);
  if (fields.length !== 5) return "Enter a valid five-field schedule";
  const [minute, hour, day, month, weekday] = fields;
  const at = /^\d+$/u.test(hour!) && /^\d+$/u.test(minute!)
    ? `at ${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`
    : `when minute “${minute}” and hour “${hour}” match`;
  if (day === "*" && month === "*" && weekday === "*") return `Every day ${at}`;
  if (day === "*" && month === "*" && weekday === "1-5") return `Weekdays ${at}`;
  return `${at}; day ${day}, month ${month}, weekday ${weekday}`;
}

export function scheduleCountdown(iso: string, now = Date.now()): string {
  const milliseconds = Date.parse(iso) - now;
  if (!Number.isFinite(milliseconds)) return "—";
  if (milliseconds <= 0) return "due";
  if (milliseconds < 60_000) return "<1m";
  if (milliseconds < 3_600_000) return `${Math.ceil(milliseconds / 60_000)}m`;
  if (milliseconds < 86_400_000) return `${Math.ceil(milliseconds / 3_600_000)}h`;
  return `${Math.ceil(milliseconds / 86_400_000)}d`;
}
