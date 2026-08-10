import {
  SESSION_TOOL_MATERIALIZATION_CAPABILITY,
  type SessionSpec,
  type SessionToolMaterialization,
  type SessionToolMaterializationEntry,
  type SessionToolOmissionReason,
  type SessionToolPolicyDisposition,
  type SessionToolSourceClass,
} from "./session-api.js";

export const MAX_MATERIALIZED_TOOL_ENTRIES =
  SESSION_TOOL_MATERIALIZATION_CAPABILITY.maxEntries;

export interface RuntimeToolInventoryEntry {
  name: string;
  sourceClass: SessionToolSourceClass;
}

export function liveToolMaterialization(
  spec: Omit<SessionSpec, "env">,
  inventory: readonly RuntimeToolInventoryEntry[],
  activeToolNames: readonly string[],
): SessionToolMaterialization {
  const activeInput = new Set([...activeToolNames].filter(safeToolName));
  const active = boundedNames(
    activeInput,
    (spec.tools?.required ?? []).filter((name) => activeInput.has(name)),
  );
  const activeSet = new Set(active);
  const requestedNames = new Set([
    ...(spec.tools?.required ?? []),
    ...(spec.tools?.include ?? []),
    ...(spec.tools?.exclude ?? []),
  ]);
  const sortedInventory = [...inventory]
    .filter((candidate) => safeToolName(candidate.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const inventoryByName = new Map<string, RuntimeToolInventoryEntry>();
  for (const entry of [
    ...sortedInventory.filter((candidate) => requestedNames.has(candidate.name)),
    ...sortedInventory.filter((candidate) => !requestedNames.has(candidate.name)),
  ]) {
    if (inventoryByName.size >= MAX_MATERIALIZED_TOOL_ENTRIES) break;
    if (!inventoryByName.has(entry.name)) inventoryByName.set(entry.name, entry);
  }
  const names = requestedAndInventoryNames(spec, inventoryByName.keys());
  const completeNameCount = new Set([
    ...sortedInventory.map((entry) => entry.name),
    ...[...requestedNames].filter(safeToolName),
  ]).size;
  const entries = names.map((name) => {
    const runtime = inventoryByName.get(name);
    const activeTool = activeSet.has(name);
    const policyDisposition = toolPolicyDisposition(spec, name, runtime?.sourceClass);
    return {
      name,
      sourceClass: runtime?.sourceClass ?? "unknown",
      policyDisposition,
      availability: runtime === undefined ? "unavailable" : "resident",
      active: activeTool,
      required: spec.tools?.required?.includes(name) ?? false,
      ...(activeTool
        ? {}
        : {
            omissionReason: omissionReason(
              spec,
              name,
              runtime !== undefined,
              runtime?.sourceClass,
            ),
          }),
    } satisfies SessionToolMaterializationEntry;
  });
  return {
    state: "materialized",
    truncated: activeInput.size > active.length || completeNameCount > entries.length,
    active,
    required: boundedNames(spec.tools?.required ?? []),
    entries,
    ...(spec.materialization === undefined
      ? {}
      : { provenance: structuredClone(spec.materialization) }),
  };
}

export function unavailableToolMaterialization(
  spec: Omit<SessionSpec, "env">,
  state: "not-resident" | "unavailable",
): SessionToolMaterialization {
  const reason: SessionToolOmissionReason =
    state === "not-resident" ? "runtime_not_resident" : "runtime_inventory_unavailable";
  const availability = state === "not-resident" ? "dormant" : "unavailable";
  const requested = [
    ...(spec.tools?.required ?? []),
    ...(spec.tools?.include ?? []),
    ...(spec.tools?.exclude ?? []),
  ].filter(safeToolName);
  const names = requestedAndInventoryNames(spec, []);
  return {
    state,
    truncated: new Set(requested).size > names.length,
    active: [],
    required: boundedNames(spec.tools?.required ?? []),
    entries: names.map((name) => ({
      name,
      sourceClass: "unknown",
      policyDisposition: toolPolicyDisposition(spec, name),
      availability,
      active: false,
      required: spec.tools?.required?.includes(name) ?? false,
      omissionReason: reason,
    })),
    ...(spec.materialization === undefined
      ? {}
      : { provenance: structuredClone(spec.materialization) }),
  };
}

function requestedAndInventoryNames(
  spec: Omit<SessionSpec, "env">,
  inventoryNames: Iterable<string>,
): string[] {
  const requested = [
    ...(spec.tools?.required ?? []),
    ...(spec.tools?.include ?? []),
    ...(spec.tools?.exclude ?? []),
  ].filter(safeToolName);
  return boundedNames(inventoryNames, requested);
}

function boundedNames(names: Iterable<string>, priority: Iterable<string> = []): string[] {
  const prioritized = [...new Set([...priority].filter(safeToolName))]
    .sort((left, right) => left.localeCompare(right));
  const prioritySet = new Set(prioritized);
  const remaining = [...new Set([...names].filter(safeToolName))]
    .filter((name) => !prioritySet.has(name))
    .sort((left, right) => left.localeCompare(right));
  return [...prioritized, ...remaining].slice(0, MAX_MATERIALIZED_TOOL_ENTRIES);
}

function safeToolName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function toolPolicyDisposition(
  spec: Omit<SessionSpec, "env">,
  name: string,
  sourceClass?: SessionToolSourceClass,
): SessionToolPolicyDisposition {
  if (spec.tools?.required?.includes(name)) return "required";
  if (spec.tools?.mode === "none" || spec.tools?.exclude?.includes(name)) return "excluded";
  if (spec.tools?.mode === "allowlist" && !spec.tools.include?.includes(name)) {
    return "not-selected";
  }
  if (spec.tools?.mode === "no-builtin" && sourceClass === "builtin") return "not-selected";
  return "allowed";
}

function omissionReason(
  spec: Omit<SessionSpec, "env">,
  name: string,
  registered: boolean,
  sourceClass?: SessionToolSourceClass,
): SessionToolOmissionReason {
  if (!registered) return "not_registered";
  if (spec.tools?.mode === "none") return "tools_disabled";
  if (spec.tools?.exclude?.includes(name)) return "excluded_by_policy";
  if (spec.tools?.mode === "allowlist" && !spec.tools.include?.includes(name)) {
    return "not_selected_by_policy";
  }
  if (spec.tools?.mode === "no-builtin" && sourceClass === "builtin") {
    return "not_selected_by_policy";
  }
  return "inactive_in_runtime";
}
