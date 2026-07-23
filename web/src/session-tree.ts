import { DASH_DEFAULT_LIMITS } from "@harryaskham/pi-daemon/dashboard-contract";

export const SESSION_TREE_DEFAULT_LIMITS = {
  maxNodes: DASH_DEFAULT_LIMITS.maxTreeNodes,
  maxDepth: DASH_DEFAULT_LIMITS.maxTreeDepth,
  maxTextBytes: DASH_DEFAULT_LIMITS.maxTreeTextBytes,
  maxSnippetBytes: DASH_DEFAULT_LIMITS.maxTreeSnippetBytes,
} as const;

export interface SessionTreeLimits {
  maxNodes: number;
  maxDepth: number;
  maxTextBytes: number;
  maxSnippetBytes: number;
}

export interface SessionTreeEntry {
  id: string;
  parentId: string | null;
  childrenIds: string[];
  depth: number;
  type: string;
  timestamp: string;
  label?: string;
  labelTimestamp?: string;
  role?: string;
  summary: string;
  userText?: string;
  activeLeaf: boolean;
  onActivePath: boolean;
  branchPoint: boolean;
}

export interface SessionTreeModel {
  entries: SessionTreeEntry[];
  byId: ReadonlyMap<string, SessionTreeEntry>;
  rootIds: string[];
  leafId: string | null;
  activePathIds: string[];
  branchCount: number;
}

export interface SessionTreeFilter {
  query?: string;
  types?: string[];
  labeledOnly?: boolean;
  branchPointsOnly?: boolean;
  modifiedAfter?: string;
}

export interface SessionTreeComparison {
  left: SessionTreeEntry;
  right: SessionTreeEntry;
  commonAncestorId?: string;
  leftPath: SessionTreeEntry[];
  rightPath: SessionTreeEntry[];
}

export class SessionTreeValidationError extends Error {
  constructor(readonly code: "invalid-tree" | "tree-capacity", readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "SessionTreeValidationError";
  }
}

interface MutableTreeEntry extends Omit<SessionTreeEntry, "activeLeaf" | "onActivePath" | "branchPoint"> {
  activeLeaf: boolean;
  onActivePath: boolean;
  branchPoint: boolean;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const encoder = new TextEncoder();

export function parseSessionTree(
  value: unknown,
  overrides: Partial<SessionTreeLimits> = {},
): SessionTreeModel {
  const limits = resolveLimits(overrides);
  const response = record(value, "$", ["tree", "leafId"]);
  if (!Array.isArray(response.tree)) invalid("$.tree", "must be an array");
  const leafId = response.leafId === null ? null : identifier(response.leafId, "$.leafId");
  const entries: MutableTreeEntry[] = [];
  const mutableById = new Map<string, MutableTreeEntry>();
  const rootIds: string[] = [];
  let textBytes = 0;
  let branchCount = 0;
  const stack: Array<{ value: unknown; parentId: string | null; depth: number; path: string }> = [];
  for (let index = response.tree.length - 1; index >= 0; index -= 1) {
    stack.push({ value: response.tree[index], parentId: null, depth: 1, path: `$.tree[${index}]` });
  }
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.depth > limits.maxDepth) capacity(frame.path, "tree depth exceeds the limit");
    if (entries.length >= limits.maxNodes) capacity(frame.path, "tree node count exceeds the limit");
    const node = record(frame.value, frame.path, ["entry", "children", "label", "labelTimestamp"]);
    const entry = record(node.entry, `${frame.path}.entry`);
    const id = identifier(entry.id, `${frame.path}.entry.id`);
    if (mutableById.has(id)) invalid(`${frame.path}.entry.id`, "entry ID is duplicated");
    const parentId = entry.parentId === null ? null : identifier(entry.parentId, `${frame.path}.entry.parentId`);
    if (parentId !== frame.parentId) invalid(`${frame.path}.entry.parentId`, "entry parent does not match tree structure");
    const type = boundedText(entry.type, `${frame.path}.entry.type`, 128);
    const timestamp = timestampText(entry.timestamp, `${frame.path}.entry.timestamp`);
    if (!Array.isArray(node.children)) invalid(`${frame.path}.children`, "must be an array");
    if (node.children.length > limits.maxNodes) capacity(`${frame.path}.children`, "child count exceeds the node limit");
    const childrenIds = node.children.map((child, index) => {
      const childNode = record(child, `${frame.path}.children[${index}]`);
      const childEntry = record(childNode.entry, `${frame.path}.children[${index}].entry`);
      return identifier(childEntry.id, `${frame.path}.children[${index}].entry.id`);
    });
    if (new Set(childrenIds).size !== childrenIds.length) invalid(`${frame.path}.children`, "child IDs must be unique");
    const label = node.label === undefined ? undefined : boundedText(node.label, `${frame.path}.label`, 512, true);
    const labelTimestamp = node.labelTimestamp === undefined ? undefined : timestampText(node.labelTimestamp, `${frame.path}.labelTimestamp`);
    const projected = projectEntry(entry, type, frame.path, limits.maxSnippetBytes);
    textBytes += bytes(projected.summary) + (projected.userText === undefined ? 0 : bytes(projected.userText)) + (label === undefined ? 0 : bytes(label));
    if (textBytes > limits.maxTextBytes) capacity(frame.path, "aggregate tree text exceeds the limit");
    const normalized: MutableTreeEntry = {
      id,
      parentId,
      childrenIds,
      depth: frame.depth,
      type,
      timestamp,
      ...(label === undefined ? {} : { label }),
      ...(labelTimestamp === undefined ? {} : { labelTimestamp }),
      ...(projected.role === undefined ? {} : { role: projected.role }),
      summary: projected.summary,
      ...(projected.userText === undefined ? {} : { userText: projected.userText }),
      activeLeaf: false,
      onActivePath: false,
      branchPoint: childrenIds.length > 1,
    };
    if (normalized.branchPoint) branchCount += 1;
    entries.push(normalized);
    mutableById.set(id, normalized);
    if (parentId === null) rootIds.push(id);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push({
        value: node.children[index],
        parentId: id,
        depth: frame.depth + 1,
        path: `${frame.path}.children[${index}]`,
      });
    }
  }
  if (leafId !== null && !mutableById.has(leafId)) invalid("$.leafId", "active leaf is not present in the tree");
  const activePathIds: string[] = [];
  let current = leafId === null ? undefined : mutableById.get(leafId);
  const visited = new Set<string>();
  while (current !== undefined) {
    if (visited.has(current.id)) invalid("$.tree", "active path contains a cycle");
    visited.add(current.id);
    activePathIds.push(current.id);
    current.onActivePath = true;
    if (current.id === leafId) current.activeLeaf = true;
    if (current.parentId === null) current = undefined;
    else {
      const parent = mutableById.get(current.parentId);
      if (parent === undefined) invalid("$.tree", "active path parent is missing");
      current = parent;
    }
  }
  activePathIds.reverse();
  return {
    entries,
    byId: mutableById,
    rootIds,
    leafId,
    activePathIds,
    branchCount,
  };
}

export function filterSessionTree(model: SessionTreeModel, filter: SessionTreeFilter): SessionTreeEntry[] {
  const query = filter.query?.trim().toLocaleLowerCase() ?? "";
  const types = new Set(filter.types ?? []);
  const after = filter.modifiedAfter === undefined ? undefined : Date.parse(filter.modifiedAfter);
  const matched = new Set<string>();
  for (const entry of model.entries) {
    if (query.length > 0 && !`${entry.label ?? ""}\n${entry.summary}\n${entry.type}\n${entry.role ?? ""}`.toLocaleLowerCase().includes(query)) continue;
    if (types.size > 0 && !types.has(entry.type)) continue;
    if (filter.labeledOnly && entry.label === undefined) continue;
    if (filter.branchPointsOnly && !entry.branchPoint) continue;
    if (after !== undefined && (!Number.isFinite(after) || Date.parse(entry.timestamp) < after)) continue;
    matched.add(entry.id);
    let parentId = entry.parentId;
    while (parentId !== null) {
      matched.add(parentId);
      parentId = model.byId.get(parentId)?.parentId ?? null;
    }
  }
  if (query.length === 0 && types.size === 0 && !filter.labeledOnly && !filter.branchPointsOnly && after === undefined) return model.entries;
  return model.entries.filter((entry) => matched.has(entry.id));
}

export function compareSessionTreeEntries(
  model: SessionTreeModel,
  leftId: string,
  rightId: string,
): SessionTreeComparison {
  const left = requireEntry(model, leftId);
  const right = requireEntry(model, rightId);
  const leftAncestors = pathToRoot(model, left).reverse();
  const rightAncestors = pathToRoot(model, right).reverse();
  let common = -1;
  while (common + 1 < leftAncestors.length && common + 1 < rightAncestors.length && leftAncestors[common + 1]?.id === rightAncestors[common + 1]?.id) common += 1;
  return {
    left,
    right,
    ...(common < 0 ? {} : { commonAncestorId: leftAncestors[common]!.id }),
    leftPath: leftAncestors.slice(common + 1),
    rightPath: rightAncestors.slice(common + 1),
  };
}

export function adjacentSessionTreeEntry(
  visible: readonly SessionTreeEntry[],
  currentId: string | undefined,
  direction: "next" | "previous" | "first" | "last",
): SessionTreeEntry | undefined {
  if (visible.length === 0) return undefined;
  if (direction === "first") return visible[0];
  if (direction === "last") return visible.at(-1);
  const index = currentId === undefined ? -1 : visible.findIndex((entry) => entry.id === currentId);
  if (direction === "next") return visible[Math.min(visible.length - 1, Math.max(0, index + 1))];
  return visible[Math.max(0, index <= 0 ? 0 : index - 1)];
}

function pathToRoot(model: SessionTreeModel, entry: SessionTreeEntry): SessionTreeEntry[] {
  const path: SessionTreeEntry[] = [];
  const visited = new Set<string>();
  let current: SessionTreeEntry | undefined = entry;
  while (current !== undefined) {
    if (visited.has(current.id)) invalid("$.tree", "tree contains a parent cycle");
    visited.add(current.id);
    path.push(current);
    current = current.parentId === null ? undefined : model.byId.get(current.parentId);
  }
  return path;
}

function requireEntry(model: SessionTreeModel, id: string): SessionTreeEntry {
  const entry = model.byId.get(id);
  if (entry === undefined) invalid("$.entryId", "tree entry does not exist");
  return entry;
}

function projectEntry(entry: Record<string, unknown>, type: string, path: string, maxSnippetBytes: number): { summary: string; role?: string; userText?: string } {
  if (type === "message") {
    const message = record(entry.message, `${path}.entry.message`);
    const role = typeof message.role === "string" ? boundedText(message.role, `${path}.entry.message.role`, 64) : "custom";
    const content = messageText(message.content);
    const summary = snippet(content || `${role} message`, maxSnippetBytes);
    return {
      summary,
      role,
      ...(role === "user" && content.length > 0 ? { userText: snippet(content, 8_192) } : {}),
    };
  }
  if (type === "compaction" || type === "branch_summary") {
    return { summary: snippet(typeof entry.summary === "string" ? entry.summary : type.replaceAll("_", " "), maxSnippetBytes) };
  }
  if (type === "model_change") return { summary: snippet(`${String(entry.provider ?? "model")}/${String(entry.modelId ?? "unknown")}`, maxSnippetBytes) };
  if (type === "thinking_level_change") return { summary: snippet(`Thinking: ${String(entry.thinkingLevel ?? "unknown")}`, maxSnippetBytes) };
  if (type === "label") return { summary: snippet(typeof entry.label === "string" ? entry.label : "Label cleared", maxSnippetBytes) };
  if (type === "session_info") return { summary: snippet(typeof entry.name === "string" ? entry.name : "Session metadata", maxSnippetBytes) };
  if (type === "custom_message") return { summary: snippet(messageText(entry.content) || String(entry.customType ?? "custom message"), maxSnippetBytes) };
  return { summary: snippet(String(entry.customType ?? type), maxSnippetBytes) };
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (typeof item !== "object" || item === null || Array.isArray(item)) return "";
    const object = item as Record<string, unknown>;
    return object.type === "text" && typeof object.text === "string" ? object.text : object.type === "image" ? "[image]" : "";
  }).filter(Boolean).join("\n");
}

function snippet(value: string, maxBytes: number): string {
  const normalized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").trim();
  if (bytes(normalized) <= maxBytes) return normalized;
  let end = Math.min(normalized.length, maxBytes);
  while (end > 0 && bytes(normalized.slice(0, end)) > maxBytes) end -= 1;
  return `${normalized.slice(0, end).trimEnd()}…`;
}

function record(value: unknown, path: string, allowed?: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(path, "must be an object");
  const object = value as Record<string, unknown>;
  if (allowed !== undefined) {
    const accepted = new Set(allowed);
    for (const key of Object.keys(object)) if (!accepted.has(key)) invalid(`${path}.${key}`, "unknown field");
  }
  return object;
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== "string" || !ID.test(value)) invalid(path, "must be an identifier");
  return value;
}

function boundedText(value: unknown, path: string, maxBytes: number, empty = false): string {
  if (typeof value !== "string" || (!empty && value.length === 0) || bytes(value) > maxBytes) invalid(path, "must be bounded text");
  return value;
}

function timestampText(value: unknown, path: string): string {
  const timestamp = boundedText(value, path, 64);
  if (!Number.isFinite(Date.parse(timestamp))) invalid(path, "must be a timestamp");
  return timestamp;
}

function resolveLimits(overrides: Partial<SessionTreeLimits>): SessionTreeLimits {
  const limits = { ...SESSION_TREE_DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  }
  return limits;
}

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function invalid(path: string, message: string): never {
  throw new SessionTreeValidationError("invalid-tree", path, message);
}

function capacity(path: string, message: string): never {
  throw new SessionTreeValidationError("tree-capacity", path, message);
}
