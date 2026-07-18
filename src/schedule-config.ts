import { lstat, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { parseDocument } from "yaml";

import type { LoadedPiDaemonConfig } from "./config.js";
import type { ScheduleResource } from "./schedule-contract.js";
import { FileScheduleStore, type ScheduleDefinition } from "./schedule-store.js";

const MAX_IMPORT_BYTES = 1024 * 1024;

export interface ScheduleImportResult {
  imported: number;
  created: number;
  updated: number;
  unchanged: number;
}

/**
 * Reconciles explicitly referenced startup schedule files. Imports never run
 * timers and never place prompt content in argv, status, or log fields.
 */
export async function importConfiguredSchedules(options: {
  loadedConfig: LoadedPiDaemonConfig;
  store: FileScheduleStore;
  resolveSession: (sessionRef: string) => Promise<string | undefined>;
}): Promise<ScheduleImportResult> {
  const imports = options.loadedConfig.config.schedules?.imports ?? [];
  const defaults = options.loadedConfig.config.schedules?.defaults ?? {};
  const definitions: ScheduleDefinition[] = [];
  for (const reference of imports) {
    const path = options.loadedConfig.resolvePath(reference);
    const value = await readConfigData(path);
    const records = Array.isArray(value)
      ? value
      : isRecord(value) && Array.isArray(value.schedules)
        ? value.schedules
        : [value];
    for (const candidate of records) {
      if (!isRecord(candidate)) throw new Error("schedule import must contain schedule objects");
      const merged: Record<string, unknown> = { ...defaults, ...candidate };
      if (merged.promptFile !== undefined) {
        if (typeof merged.promptFile !== "string" || merged.prompt !== undefined) {
          throw new Error("schedule import must use exactly one of prompt or promptFile");
        }
        merged.prompt = await readPrivatePrompt(resolve(dirname(path), merged.promptFile));
        delete merged.promptFile;
      }
      if (typeof merged.scheduleId !== "string" || typeof merged.sessionRef !== "string") {
        throw new Error("schedule import requires scheduleId and sessionRef");
      }
      const sessionId = await options.resolveSession(merged.sessionRef);
      if (sessionId === undefined) throw new Error("schedule import refers to an unknown session");
      merged.sessionRef = sessionId;
      definitions.push(merged as unknown as ScheduleDefinition);
    }
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  await options.store.recover();
  for (const definition of definitions) {
    const current = await options.store.get(definition.scheduleId);
    if (current === undefined) {
      await options.store.create(definition);
      created += 1;
    } else if (sameDefinition(current, definition)) {
      unchanged += 1;
    } else {
      await options.store.update(current.scheduleId, current.revision, definition);
      updated += 1;
    }
  }
  return { imported: definitions.length, created, updated, unchanged };
}

async function readConfigData(path: string): Promise<unknown> {
  const info = await stat(path);
  const getuid = process.getuid;
  if (!info.isFile() || (getuid !== undefined && info.uid !== getuid() && info.uid !== 0) || (info.mode & 0o022) !== 0 || info.size < 1 || info.size > MAX_IMPORT_BYTES) {
    throw new Error("schedule import must be a bounded non-writable regular file owned by the current user or root");
  }
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES) throw new Error("schedule import exceeds its byte limit");
  if (!/\.ya?ml$/iu.test(path)) {
    try { return JSON.parse(text) as unknown; } catch { throw new Error("schedule import is not valid JSON"); }
  }
  const document = parseDocument(text, { prettyErrors: false, strict: true, uniqueKeys: true });
  if (document.errors.length > 0) throw new Error("schedule import is not valid YAML");
  try { return document.toJS({ maxAliasCount: 0 }) as unknown; } catch { throw new Error("schedule import aliases are not allowed"); }
}

async function readPrivatePrompt(path: string): Promise<string> {
  const info = await lstat(path);
  const getuid = process.getuid;
  if (info.isSymbolicLink() || !info.isFile() || (getuid !== undefined && info.uid !== getuid()) || (info.mode & 0o077) !== 0 || info.size < 1 || info.size > 65_536) {
    throw new Error("schedule promptFile must be an owner-only bounded regular non-symlink file");
  }
  const value = await readFile(path, "utf8");
  if (Buffer.byteLength(value, "utf8") > 65_536) throw new Error("schedule promptFile exceeds its byte limit");
  return value;
}

function sameDefinition(resource: ScheduleResource, definition: ScheduleDefinition): boolean {
  const { contractVersion: _contractVersion, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...current } = resource;
  return stableJson(current) === stableJson(definition);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
