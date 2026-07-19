import { readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  atomicWritePrivateJson,
  DurabilityError,
  ensurePrivateDirectory,
  readPrivateJsonIfExists,
  stateFileSize,
  validatePrivateFileIfExists,
} from "./durability.js";
import {
  SCHEDULE_CONTRACT_VERSION,
  SCHEDULE_STORE_FORMAT_VERSION,
  resolveScheduleLimits,
  validateScheduleResource,
  type ScheduleLimits,
  type ScheduleResource,
} from "./schedule-contract.js";

interface ScheduleEnvelope {
  formatVersion: typeof SCHEDULE_STORE_FORMAT_VERSION;
  resource: ScheduleResource;
}

export type ScheduleDefinition = Omit<ScheduleResource, "contractVersion" | "revision" | "createdAt" | "updatedAt">;

export interface ScheduleRecovery {
  schedules: ScheduleResource[];
  quarantined: string[];
  scannedBytes: number;
}

export interface ScheduleRuntimeState {
  nextTriggerAt?: string;
  lastTrigger?: ScheduleResource["lastTrigger"];
}

export interface FileScheduleStoreOptions {
  stateDir: string;
  limits?: Partial<ScheduleLimits>;
  now?: () => Date;
}

export class ScheduleStoreError extends Error {
  readonly code: "already_exists" | "not_found" | "revision_conflict" | "schedule_capacity" | "recovery_limit";
  constructor(code: ScheduleStoreError["code"], message: string) {
    super(message);
    this.name = "ScheduleStoreError";
    this.code = code;
  }
}

/**
 * Durable schedule resource storage only. This class never calculates wakes,
 * starts timers, submits prompts, or reads credentials.
 */
export class FileScheduleStore {
  readonly schedulesDir: string;
  readonly limits: ScheduleLimits;
  readonly #now: () => Date;
  readonly #records = new Map<string, ScheduleResource>();
  #recovery: Promise<ScheduleRecovery> | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: FileScheduleStoreOptions) {
    if (!options.stateDir) throw new Error("stateDir must not be empty");
    this.schedulesDir = join(options.stateDir, "schedules", `v${SCHEDULE_STORE_FORMAT_VERSION}`);
    this.limits = resolveScheduleLimits(options.limits);
    this.#now = options.now ?? (() => new Date());
  }

  recover(): Promise<ScheduleRecovery> {
    this.#recovery ??= this.#load();
    return this.#recovery.then((result) => structuredClone(result));
  }

  async list(sessionRef?: string): Promise<ScheduleResource[]> {
    await this.recover();
    return [...this.#records.values()]
      .filter((resource) => sessionRef === undefined || resource.sessionRef === sessionRef)
      .sort((left, right) => left.scheduleId.localeCompare(right.scheduleId))
      .map((resource) => structuredClone(resource));
  }

  async get(scheduleId: string): Promise<ScheduleResource | undefined> {
    await this.recover();
    const record = this.#records.get(scheduleId);
    return record === undefined ? undefined : structuredClone(record);
  }

  async create(definition: ScheduleDefinition): Promise<ScheduleResource> {
    await this.recover();
    return this.#serialize(async () => {
      if (this.#records.has(definition.scheduleId)) throw new ScheduleStoreError("already_exists", "schedule already exists");
      if (this.#records.size >= this.limits.maxSchedules) throw new ScheduleStoreError("schedule_capacity", "schedule capacity is exhausted");
      const perSession = [...this.#records.values()].filter((record) => record.sessionRef === definition.sessionRef).length;
      if (perSession >= this.limits.maxSchedulesPerSession) throw new ScheduleStoreError("schedule_capacity", "per-session schedule capacity is exhausted");
      const now = this.#timestamp();
      const resource = validateScheduleResource({ ...structuredClone(definition), contractVersion: SCHEDULE_CONTRACT_VERSION, revision: 0, createdAt: now, updatedAt: now }, this.limits);
      await this.#write(resource);
      this.#records.set(resource.scheduleId, resource);
      return structuredClone(resource);
    });
  }

  async update(scheduleId: string, expectedRevision: number, definition: ScheduleDefinition): Promise<ScheduleResource> {
    await this.recover();
    return this.#serialize(async () => {
      const current = this.#records.get(scheduleId);
      if (current === undefined) throw new ScheduleStoreError("not_found", "schedule does not exist");
      if (current.revision !== expectedRevision) throw new ScheduleStoreError("revision_conflict", "schedule revision precondition failed");
      if (definition.scheduleId !== scheduleId || definition.sessionRef !== current.sessionRef) throw new ScheduleStoreError("revision_conflict", "scheduleId and sessionRef are immutable");
      const resource = validateScheduleResource({ ...structuredClone(definition), contractVersion: SCHEDULE_CONTRACT_VERSION, revision: current.revision + 1, createdAt: current.createdAt, updatedAt: this.#timestamp() }, this.limits);
      await this.#write(resource);
      this.#records.set(scheduleId, resource);
      return structuredClone(resource);
    });
  }

  /**
   * Atomically advances timer-owned state without allowing the runtime to
   * overwrite a concurrent CRUD replacement. The revision is incremented so
   * callers observing a schedule can detect every durable trigger decision.
   */
  async updateRuntimeState(
    scheduleId: string,
    expectedRevision: number,
    state: ScheduleRuntimeState,
  ): Promise<ScheduleResource> {
    await this.recover();
    return this.#serialize(async () => {
      const current = this.#records.get(scheduleId);
      if (current === undefined) throw new ScheduleStoreError("not_found", "schedule does not exist");
      if (current.revision !== expectedRevision) throw new ScheduleStoreError("revision_conflict", "schedule revision precondition failed");
      const next = structuredClone(current);
      next.revision += 1;
      next.updatedAt = this.#timestamp();
      if (state.nextTriggerAt === undefined) delete next.nextTriggerAt;
      else next.nextTriggerAt = state.nextTriggerAt;
      if (state.lastTrigger === undefined) delete next.lastTrigger;
      else next.lastTrigger = structuredClone(state.lastTrigger);
      const resource = validateScheduleResource(next, this.limits);
      await this.#write(resource);
      this.#records.set(scheduleId, resource);
      return structuredClone(resource);
    });
  }

  async delete(scheduleId: string, expectedRevision: number): Promise<void> {
    await this.recover();
    await this.#serialize(async () => {
      const current = this.#records.get(scheduleId);
      if (current === undefined) throw new ScheduleStoreError("not_found", "schedule does not exist");
      if (current.revision !== expectedRevision) throw new ScheduleStoreError("revision_conflict", "schedule revision precondition failed");
      await rm(this.#path(scheduleId));
      this.#records.delete(scheduleId);
    });
  }

  async #load(): Promise<ScheduleRecovery> {
    await ensurePrivateDirectory(join(this.schedulesDir, "..", ".."), "daemon state directory");
    await ensurePrivateDirectory(join(this.schedulesDir, ".."), "schedule state directory");
    await ensurePrivateDirectory(this.schedulesDir, "versioned schedule state directory");
    const entries = (await readdir(this.schedulesDir, { withFileTypes: true }))
      .filter((entry) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.json$/u.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (entries.length > this.limits.maxSchedules) throw new ScheduleStoreError("schedule_capacity", "persisted schedule count exceeds capacity");
    let scannedBytes = 0;
    const quarantined: string[] = [];
    for (const entry of entries) {
      const path = join(this.schedulesDir, entry.name);
      await validatePrivateFileIfExists(path, "schedule state file");
      const size = await stateFileSize(path) ?? 0;
      if (size > this.limits.maxRecordBytes) {
        quarantined.push(await this.#quarantine(path));
        continue;
      }
      scannedBytes += size;
      if (scannedBytes > this.limits.maxRecoveryBytes) throw new ScheduleStoreError("recovery_limit", "schedule recovery byte limit exceeded");
      try {
        const value = await readPrivateJsonIfExists<unknown>(path);
        const envelope = this.#envelope(value);
        const expectedId = entry.name.slice(0, -5);
        if (envelope.resource.scheduleId !== expectedId || this.#records.has(expectedId)) throw new Error("schedule filename does not match resource identity");
        this.#records.set(expectedId, envelope.resource);
      } catch (error) {
        if (error instanceof DurabilityError && error.code === "insecure_state_path") throw error;
        quarantined.push(await this.#quarantine(path));
      }
    }
    const sessionCounts = new Map<string, number>();
    for (const resource of this.#records.values()) {
      const count = (sessionCounts.get(resource.sessionRef) ?? 0) + 1;
      if (count > this.limits.maxSchedulesPerSession) throw new ScheduleStoreError("schedule_capacity", "persisted per-session schedule count exceeds capacity");
      sessionCounts.set(resource.sessionRef, count);
    }
    return { schedules: await this.listLoaded(), quarantined, scannedBytes };
  }

  #envelope(value: unknown): ScheduleEnvelope {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid schedule envelope");
    const object = value as Record<string, unknown>;
    if (Object.keys(object).some((key) => key !== "formatVersion" && key !== "resource") || object.formatVersion !== SCHEDULE_STORE_FORMAT_VERSION) throw new Error("unsupported schedule store format");
    return { formatVersion: SCHEDULE_STORE_FORMAT_VERSION, resource: validateScheduleResource(object.resource, this.limits) };
  }

  async listLoaded(): Promise<ScheduleResource[]> {
    return [...this.#records.values()].sort((a, b) => a.scheduleId.localeCompare(b.scheduleId)).map((value) => structuredClone(value));
  }

  async #write(resource: ScheduleResource): Promise<void> {
    await atomicWritePrivateJson(this.#path(resource.scheduleId), { formatVersion: SCHEDULE_STORE_FORMAT_VERSION, resource } satisfies ScheduleEnvelope);
  }

  async #quarantine(path: string): Promise<string> {
    const target = `${path}.corrupt-${this.#timestamp().replace(/[:.]/gu, "-")}`;
    await rename(path, target);
    return target;
  }

  #path(scheduleId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(scheduleId)) throw new Error("invalid scheduleId");
    return join(this.schedulesDir, `${scheduleId}.json`);
  }

  #timestamp(): string {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) throw new Error("now returned an invalid date");
    return now.toISOString();
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
