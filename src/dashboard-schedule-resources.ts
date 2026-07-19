import type {
  DashboardScheduleResource,
  DashboardScheduleStatus,
  DashboardScheduleWrite,
} from "./dashboard-contract.js";
import type { ScheduleDefinition } from "./schedule-store.js";
import type { ScheduleResource } from "./schedule-contract.js";

/** Removes owner-private prompt content before a schedule crosses the browser BFF seam. */
export function browserScheduleResource(resource: ScheduleResource): DashboardScheduleResource {
  const { prompt: _prompt, ...safe } = structuredClone(resource);
  return { ...safe, promptConfigured: true };
}

export function scheduleEtag(scheduleId: string, revision: number): string {
  return `"${Buffer.from(scheduleId, "utf8").toString("base64url")}:${revision}"`;
}

export function scheduleDefinition(
  write: DashboardScheduleWrite,
  prompt: string,
): ScheduleDefinition {
  return {
    scheduleId: write.scheduleId,
    sessionRef: write.sessionRef,
    enabled: write.enabled,
    cron: write.cron,
    timezone: write.timezone,
    prompt,
    ...(write.execution === undefined ? {} : { execution: structuredClone(write.execution) }),
    overlapPolicy: write.overlapPolicy,
    missedWakePolicy: structuredClone(write.missedWakePolicy),
    jitterMs: write.jitterMs,
    maxAdmissionDelayMs: write.maxAdmissionDelayMs,
  };
}

export function scheduleStatus(
  resources: readonly ScheduleResource[],
  timerRuntime = false,
  authoritativeNextWakeAt?: string,
): DashboardScheduleStatus {
  const nextWakeAt = authoritativeNextWakeAt ?? resources
    .filter((resource) => resource.enabled && resource.nextTriggerAt !== undefined)
    .map((resource) => resource.nextTriggerAt!)
    .sort()[0];
  return {
    timerRuntime,
    externalTimersSupported: true,
    scheduleCount: resources.length,
    enabledCount: resources.filter((resource) => resource.enabled).length,
    ...(nextWakeAt === undefined ? {} : { nextWakeAt }),
  };
}
