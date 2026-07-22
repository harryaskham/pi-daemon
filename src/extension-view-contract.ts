export const EXTENSION_VIEW_PROTOCOL = "pi-declarative-view" as const;
export const EXTENSION_VIEW_VERSION = "1.0" as const;
export const EXTENSION_VIEW_RPC_METHOD = "render_view" as const;

export interface ExtensionViewLimits {
  maxViewBytes: number;
  maxNodes: number;
  maxDepth: number;
  maxTextBytes: number;
  maxActions: number;
  maxFields: number;
  maxOptions: number;
  maxImages: number;
}

export const EXTENSION_VIEW_DEFAULT_LIMITS = {
  maxViewBytes: 262_144,
  maxNodes: 256,
  maxDepth: 16,
  maxTextBytes: 131_072,
  maxActions: 32,
  maxFields: 32,
  maxOptions: 128,
  maxImages: 16,
} as const satisfies ExtensionViewLimits;

export interface ExtensionViewCapability {
  protocol: typeof EXTENSION_VIEW_PROTOCOL;
  version: typeof EXTENSION_VIEW_VERSION;
  source: "pi-rpc-proposal";
  renderers: {
    rich: "native";
    tui: "fallback";
    rpc: "transport";
  };
  browserCodeExecution: false;
  imageSources: "authorized-blob-only";
  limits: ExtensionViewLimits;
}

export const EXTENSION_VIEW_CAPABILITY = {
  protocol: EXTENSION_VIEW_PROTOCOL,
  version: EXTENSION_VIEW_VERSION,
  source: "pi-rpc-proposal",
  renderers: { rich: "native", tui: "fallback", rpc: "transport" },
  browserCodeExecution: false,
  imageSources: "authorized-blob-only",
  limits: { ...EXTENSION_VIEW_DEFAULT_LIMITS },
} as const satisfies ExtensionViewCapability;

export interface ExtensionViewCapabilities {
  /** View-scoped action IDs that the renderer may return to the host. */
  actions: string[];
  links: "none";
  images: "authorized-blob-only";
}

export interface ExtensionTextNode {
  type: "text";
  text: string;
}

export interface ExtensionMarkdownNode {
  type: "markdown";
  text: string;
}

export interface ExtensionCodeNode {
  type: "code";
  code: string;
  language?: string;
  filename?: string;
}

export interface ExtensionDiffNode {
  type: "diff";
  diff: string;
  language?: string;
}

export interface ExtensionImageNode {
  type: "image";
  blobRef: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  alt: string;
  width?: number;
  height?: number;
}

export interface ExtensionKeyValueNode {
  type: "key-value";
  entries: Array<{ key: string; value: string }>;
}

export interface ExtensionStatusNode {
  type: "status";
  tone: "neutral" | "info" | "success" | "warning" | "error";
  label: string;
  detail?: string;
}

export interface ExtensionStackNode {
  type: "stack";
  gap?: "compact" | "normal" | "relaxed";
  children: ExtensionViewNode[];
}

export interface ExtensionGridNode {
  type: "grid";
  columns: 1 | 2 | 3 | 4;
  children: ExtensionViewNode[];
}

export interface ExtensionActionNode {
  type: "action";
  actionId: string;
  label: string;
  tone?: "default" | "primary" | "danger";
}

interface ExtensionFormFieldBase {
  name: string;
  label: string;
  required?: boolean;
}

export interface ExtensionTextField extends ExtensionFormFieldBase {
  type: "text" | "multiline";
  placeholder?: string;
  initial?: string;
}

export interface ExtensionSelectField extends ExtensionFormFieldBase {
  type: "select";
  options: Array<{ value: string; label: string }>;
  initial?: string;
}

export interface ExtensionBooleanField extends ExtensionFormFieldBase {
  type: "boolean";
  initial?: boolean;
}

export type ExtensionFormField =
  | ExtensionTextField
  | ExtensionSelectField
  | ExtensionBooleanField;

export interface ExtensionFormNode {
  type: "form";
  formId: string;
  submitActionId: string;
  submitLabel: string;
  fields: ExtensionFormField[];
}

export type ExtensionViewNode =
  | ExtensionTextNode
  | ExtensionMarkdownNode
  | ExtensionCodeNode
  | ExtensionDiffNode
  | ExtensionImageNode
  | ExtensionKeyValueNode
  | ExtensionStatusNode
  | ExtensionStackNode
  | ExtensionGridNode
  | ExtensionActionNode
  | ExtensionFormNode;

export interface ExtensionViewDocument {
  protocol: typeof EXTENSION_VIEW_PROTOCOL;
  version: typeof EXTENSION_VIEW_VERSION;
  viewId: string;
  revision: number;
  title?: string;
  fallbackText: string;
  capabilities: ExtensionViewCapabilities;
  root: ExtensionViewNode;
}

export type ExtensionViewResponseValue = string | boolean;

export interface ExtensionViewResponse {
  protocol: typeof EXTENSION_VIEW_PROTOCOL;
  version: typeof EXTENSION_VIEW_VERSION;
  viewId: string;
  revision: number;
  actionId: string;
  values?: Record<string, ExtensionViewResponseValue>;
}

export class ExtensionViewValidationError extends Error {
  constructor(
    readonly code: "invalid-view" | "unsupported-version" | "view-capacity",
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "ExtensionViewValidationError";
  }
}

interface ValidationContext {
  limits: ExtensionViewLimits;
  nodes: number;
  textBytes: number;
  fields: number;
  options: number;
  images: number;
  actionReferences: Set<string>;
  formIds: Set<string>;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LANGUAGE = /^[A-Za-z0-9][A-Za-z0-9_+.-]{0,63}$/u;
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"] as const);
const decoder = new TextEncoder();

export function parseExtensionViewDocument(
  value: unknown,
  overrides: Partial<ExtensionViewLimits> = {},
): ExtensionViewDocument {
  const limits = resolveLimits(overrides);
  if (jsonBytes(value) > limits.maxViewBytes) {
    fail("view-capacity", "$", "encoded view exceeds maxViewBytes");
  }
  const object = record(value, "$", [
    "protocol", "version", "viewId", "revision", "title", "fallbackText", "capabilities", "root",
  ]);
  if (object.protocol !== EXTENSION_VIEW_PROTOCOL) fail("unsupported-version", "$.protocol", "unsupported protocol");
  if (object.version !== EXTENSION_VIEW_VERSION) fail("unsupported-version", "$.version", "unsupported version");
  const viewId = identifier(object.viewId, "$.viewId");
  const revision = integer(object.revision, "$.revision", 0, Number.MAX_SAFE_INTEGER);
  const context: ValidationContext = {
    limits,
    nodes: 0,
    textBytes: 0,
    fields: 0,
    options: 0,
    images: 0,
    actionReferences: new Set(),
    formIds: new Set(),
  };
  const title = object.title === undefined ? undefined : text(object.title, "$.title", context, 512, true);
  const fallbackText = text(object.fallbackText, "$.fallbackText", context, 4_096);
  const capabilities = parseCapabilities(object.capabilities, context);
  const root = parseNode(object.root, "$.root", 1, context);
  const declared = new Set(capabilities.actions);
  for (const actionId of context.actionReferences) {
    if (!declared.has(actionId)) fail("invalid-view", "$.capabilities.actions", `missing referenced action ${actionId}`);
  }
  for (const actionId of declared) {
    if (!context.actionReferences.has(actionId)) fail("invalid-view", "$.capabilities.actions", `unused action capability ${actionId}`);
  }
  return {
    protocol: EXTENSION_VIEW_PROTOCOL,
    version: EXTENSION_VIEW_VERSION,
    viewId,
    revision,
    ...(title === undefined ? {} : { title }),
    fallbackText,
    capabilities,
    root,
  };
}

export function createExtensionViewResponse(
  view: ExtensionViewDocument,
  actionId: string,
  values?: Record<string, ExtensionViewResponseValue>,
): ExtensionViewResponse {
  const normalizedAction = identifier(actionId, "$.actionId");
  if (!view.capabilities.actions.includes(normalizedAction)) {
    fail("invalid-view", "$.actionId", "action is outside the view capability scope");
  }
  const normalizedValues = values === undefined ? undefined : responseValues(values);
  validateResponseAgainstView(view, normalizedAction, normalizedValues);
  return {
    protocol: EXTENSION_VIEW_PROTOCOL,
    version: EXTENSION_VIEW_VERSION,
    viewId: view.viewId,
    revision: view.revision,
    actionId: normalizedAction,
    ...(normalizedValues === undefined ? {} : { values: normalizedValues }),
  };
}

export function parseExtensionViewResponse(
  value: unknown,
  view?: ExtensionViewDocument,
): ExtensionViewResponse {
  if (jsonBytes(value) > 65_536) fail("view-capacity", "$", "encoded response exceeds 65536 bytes");
  const object = record(value, "$", ["protocol", "version", "viewId", "revision", "actionId", "values"]);
  if (object.protocol !== EXTENSION_VIEW_PROTOCOL) fail("unsupported-version", "$.protocol", "unsupported protocol");
  if (object.version !== EXTENSION_VIEW_VERSION) fail("unsupported-version", "$.version", "unsupported version");
  const parsed: ExtensionViewResponse = {
    protocol: EXTENSION_VIEW_PROTOCOL,
    version: EXTENSION_VIEW_VERSION,
    viewId: identifier(object.viewId, "$.viewId"),
    revision: integer(object.revision, "$.revision", 0, Number.MAX_SAFE_INTEGER),
    actionId: identifier(object.actionId, "$.actionId"),
    ...(object.values === undefined ? {} : { values: responseValues(object.values) }),
  };
  if (view !== undefined) {
    if (parsed.viewId !== view.viewId || parsed.revision !== view.revision) {
      fail("invalid-view", "$", "response does not match the current view revision");
    }
    if (!view.capabilities.actions.includes(parsed.actionId)) {
      fail("invalid-view", "$.actionId", "action is outside the view capability scope");
    }
    validateResponseAgainstView(view, parsed.actionId, parsed.values);
  }
  return parsed;
}

function validateResponseAgainstView(
  view: ExtensionViewDocument,
  actionId: string,
  values: Record<string, ExtensionViewResponseValue> | undefined,
): void {
  const target = findAction(view.root, actionId);
  if (target === undefined) fail("invalid-view", "$.actionId", "action is not rendered by the current view");
  if (target.type === "action") {
    if (values !== undefined && Object.keys(values).length > 0) fail("invalid-view", "$.values", "non-form action cannot carry form values");
    return;
  }
  const supplied = values ?? {};
  const fields = new Map(target.fields.map((field) => [field.name, field]));
  for (const name of Object.keys(supplied)) {
    if (!fields.has(name)) fail("invalid-view", `$.values.${name}`, "field is not declared by the form");
  }
  for (const field of target.fields) {
    const value = supplied[field.name];
    if (value === undefined) {
      if (field.required) fail("invalid-view", `$.values.${field.name}`, "required field is missing");
      continue;
    }
    if (field.type === "boolean") {
      if (typeof value !== "boolean" || (field.required && !value)) fail("invalid-view", `$.values.${field.name}`, "boolean field is invalid");
      continue;
    }
    if (typeof value !== "string") fail("invalid-view", `$.values.${field.name}`, "text field is invalid");
    if (field.required && value.length === 0) fail("invalid-view", `$.values.${field.name}`, "required field is empty");
    if (field.type === "select" && !field.options.some((option) => option.value === value)) {
      fail("invalid-view", `$.values.${field.name}`, "select value is not an allowed option");
    }
  }
}

function findAction(node: ExtensionViewNode, actionId: string): ExtensionActionNode | ExtensionFormNode | undefined {
  if (node.type === "action" && node.actionId === actionId) return node;
  if (node.type === "form" && node.submitActionId === actionId) return node;
  if (node.type === "stack" || node.type === "grid") {
    for (const child of node.children) {
      const found = findAction(child, actionId);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function parseCapabilities(value: unknown, context: ValidationContext): ExtensionViewCapabilities {
  const object = record(value, "$.capabilities", ["actions", "links", "images"]);
  if (!Array.isArray(object.actions) || object.actions.length > context.limits.maxActions) {
    fail("view-capacity", "$.capabilities.actions", "actions exceed the negotiated limit");
  }
  const actions = object.actions.map((item, index) => identifier(item, `$.capabilities.actions[${index}]`));
  if (new Set(actions).size !== actions.length) fail("invalid-view", "$.capabilities.actions", "action IDs must be unique");
  if (object.links !== "none") fail("invalid-view", "$.capabilities.links", "links must be disabled");
  if (object.images !== "authorized-blob-only") fail("invalid-view", "$.capabilities.images", "images must use authorized blobs");
  return { actions, links: "none", images: "authorized-blob-only" };
}

function parseNode(value: unknown, path: string, depth: number, context: ValidationContext): ExtensionViewNode {
  if (depth > context.limits.maxDepth) fail("view-capacity", path, "view depth exceeds the negotiated limit");
  context.nodes += 1;
  if (context.nodes > context.limits.maxNodes) fail("view-capacity", path, "node count exceeds the negotiated limit");
  const base = record(value, path);
  const type = base.type;
  if (type === "text") {
    const object = exact(base, path, ["type", "text"]);
    return { type, text: text(object.text, `${path}.text`, context, 65_536) };
  }
  if (type === "markdown") {
    const object = exact(base, path, ["type", "text"]);
    return { type, text: text(object.text, `${path}.text`, context, 65_536) };
  }
  if (type === "code") {
    const object = exact(base, path, ["type", "code", "language", "filename"]);
    const language = object.language === undefined ? undefined : languageName(object.language, `${path}.language`);
    const filename = object.filename === undefined ? undefined : text(object.filename, `${path}.filename`, context, 512, true);
    return { type, code: text(object.code, `${path}.code`, context, 65_536, true), ...(language === undefined ? {} : { language }), ...(filename === undefined ? {} : { filename }) };
  }
  if (type === "diff") {
    const object = exact(base, path, ["type", "diff", "language"]);
    const language = object.language === undefined ? undefined : languageName(object.language, `${path}.language`);
    return { type, diff: text(object.diff, `${path}.diff`, context, 65_536, true), ...(language === undefined ? {} : { language }) };
  }
  if (type === "image") {
    const object = exact(base, path, ["type", "blobRef", "mediaType", "alt", "width", "height"]);
    context.images += 1;
    if (context.images > context.limits.maxImages) fail("view-capacity", path, "image count exceeds the negotiated limit");
    if (typeof object.mediaType !== "string" || !MEDIA_TYPES.has(object.mediaType as ExtensionImageNode["mediaType"])) fail("invalid-view", `${path}.mediaType`, "unsupported image media type");
    const width = object.width === undefined ? undefined : integer(object.width, `${path}.width`, 1, 16_384);
    const height = object.height === undefined ? undefined : integer(object.height, `${path}.height`, 1, 16_384);
    return {
      type,
      blobRef: opaqueBlobRef(object.blobRef, `${path}.blobRef`),
      mediaType: object.mediaType as ExtensionImageNode["mediaType"],
      alt: text(object.alt, `${path}.alt`, context, 1_024, true),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    };
  }
  if (type === "key-value") {
    const object = exact(base, path, ["type", "entries"]);
    if (!Array.isArray(object.entries) || object.entries.length > 64) fail("view-capacity", `${path}.entries`, "entry count exceeds 64");
    return {
      type,
      entries: object.entries.map((entry, index) => {
        const itemPath = `${path}.entries[${index}]`;
        const item = record(entry, itemPath, ["key", "value"]);
        return { key: text(item.key, `${itemPath}.key`, context, 256), value: text(item.value, `${itemPath}.value`, context, 4_096, true) };
      }),
    };
  }
  if (type === "status") {
    const object = exact(base, path, ["type", "tone", "label", "detail"]);
    const tone = enumeration(object.tone, `${path}.tone`, ["neutral", "info", "success", "warning", "error"] as const);
    const detail = object.detail === undefined ? undefined : text(object.detail, `${path}.detail`, context, 4_096, true);
    return { type, tone, label: text(object.label, `${path}.label`, context, 512), ...(detail === undefined ? {} : { detail }) };
  }
  if (type === "stack" || type === "grid") {
    const allowed = type === "stack" ? ["type", "gap", "children"] : ["type", "columns", "children"];
    const object = exact(base, path, allowed);
    if (!Array.isArray(object.children) || object.children.length < 1 || object.children.length > context.limits.maxNodes) fail("view-capacity", `${path}.children`, "children are empty or exceed the node limit");
    const children = object.children.map((child, index) => parseNode(child, `${path}.children[${index}]`, depth + 1, context));
    if (type === "stack") {
      const gap = object.gap === undefined ? undefined : enumeration(object.gap, `${path}.gap`, ["compact", "normal", "relaxed"] as const);
      return { type, ...(gap === undefined ? {} : { gap }), children };
    }
    const columns = integer(object.columns, `${path}.columns`, 1, 4) as 1 | 2 | 3 | 4;
    return { type, columns, children };
  }
  if (type === "action") {
    const object = exact(base, path, ["type", "actionId", "label", "tone"]);
    const actionId = actionReference(object.actionId, `${path}.actionId`, context);
    const tone = object.tone === undefined ? undefined : enumeration(object.tone, `${path}.tone`, ["default", "primary", "danger"] as const);
    return { type, actionId, label: text(object.label, `${path}.label`, context, 512), ...(tone === undefined ? {} : { tone }) };
  }
  if (type === "form") {
    const object = exact(base, path, ["type", "formId", "submitActionId", "submitLabel", "fields"]);
    const formId = identifier(object.formId, `${path}.formId`);
    if (context.formIds.has(formId)) fail("invalid-view", `${path}.formId`, "form ID is duplicated");
    context.formIds.add(formId);
    if (!Array.isArray(object.fields) || object.fields.length < 1) fail("invalid-view", `${path}.fields`, "form fields must be a non-empty array");
    context.fields += object.fields.length;
    if (context.fields > context.limits.maxFields) fail("view-capacity", `${path}.fields`, "field count exceeds the negotiated limit");
    const names = new Set<string>();
    const fields = object.fields.map((field, index) => parseField(field, `${path}.fields[${index}]`, context, names));
    return {
      type,
      formId,
      submitActionId: actionReference(object.submitActionId, `${path}.submitActionId`, context),
      submitLabel: text(object.submitLabel, `${path}.submitLabel`, context, 512),
      fields,
    };
  }
  fail("invalid-view", `${path}.type`, "unsupported node type");
}

function parseField(value: unknown, path: string, context: ValidationContext, names: Set<string>): ExtensionFormField {
  const base = record(value, path);
  const type = base.type;
  const common = (allowed: string[]) => {
    const object = exact(base, path, allowed);
    const name = identifier(object.name, `${path}.name`);
    if (names.has(name)) fail("invalid-view", `${path}.name`, "field name is duplicated within the form");
    names.add(name);
    const required = object.required === undefined ? undefined : boolean(object.required, `${path}.required`);
    return { object, name, label: text(object.label, `${path}.label`, context, 512), required };
  };
  if (type === "text" || type === "multiline") {
    const { object, name, label, required } = common(["type", "name", "label", "required", "placeholder", "initial"]);
    const placeholder = object.placeholder === undefined ? undefined : text(object.placeholder, `${path}.placeholder`, context, 1_024, true);
    const initial = object.initial === undefined ? undefined : text(object.initial, `${path}.initial`, context, 8_192, true);
    return { type, name, label, ...(required === undefined ? {} : { required }), ...(placeholder === undefined ? {} : { placeholder }), ...(initial === undefined ? {} : { initial }) };
  }
  if (type === "select") {
    const { object, name, label, required } = common(["type", "name", "label", "required", "options", "initial"]);
    if (!Array.isArray(object.options) || object.options.length < 1) fail("invalid-view", `${path}.options`, "select options must be a non-empty array");
    context.options += object.options.length;
    if (context.options > context.limits.maxOptions) fail("view-capacity", `${path}.options`, "option count exceeds the negotiated limit");
    const options = object.options.map((option, index) => {
      const itemPath = `${path}.options[${index}]`;
      const item = record(option, itemPath, ["value", "label"]);
      return { value: text(item.value, `${itemPath}.value`, context, 512), label: text(item.label, `${itemPath}.label`, context, 512) };
    });
    if (new Set(options.map((option) => option.value)).size !== options.length) fail("invalid-view", `${path}.options`, "option values must be unique");
    const initial = object.initial === undefined ? undefined : text(object.initial, `${path}.initial`, context, 512);
    if (initial !== undefined && !options.some((option) => option.value === initial)) fail("invalid-view", `${path}.initial`, "initial value is not an option");
    return { type, name, label, ...(required === undefined ? {} : { required }), options, ...(initial === undefined ? {} : { initial }) };
  }
  if (type === "boolean") {
    const { object, name, label, required } = common(["type", "name", "label", "required", "initial"]);
    const initial = object.initial === undefined ? undefined : boolean(object.initial, `${path}.initial`);
    return { type, name, label, ...(required === undefined ? {} : { required }), ...(initial === undefined ? {} : { initial }) };
  }
  fail("invalid-view", `${path}.type`, "unsupported form field type");
}

function responseValues(value: unknown): Record<string, ExtensionViewResponseValue> {
  const object = record(value, "$.values");
  const entries = Object.entries(object);
  if (entries.length > EXTENSION_VIEW_DEFAULT_LIMITS.maxFields) fail("view-capacity", "$.values", "response field count exceeds the negotiated limit");
  const result: Record<string, ExtensionViewResponseValue> = {};
  for (const [key, item] of entries) {
    const name = identifier(key, `$.values.${key}`);
    if (typeof item === "boolean") result[name] = item;
    else if (typeof item === "string") {
      if (bytes(item) > 8_192 || hasUnsafeControl(item)) fail("view-capacity", `$.values.${key}`, "response text is invalid or too large");
      result[name] = item;
    } else fail("invalid-view", `$.values.${key}`, "response values must be strings or booleans");
  }
  return result;
}

function resolveLimits(overrides: Partial<ExtensionViewLimits>): ExtensionViewLimits {
  const limits = { ...EXTENSION_VIEW_DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  }
  return limits;
}

function record(value: unknown, path: string, allowed?: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("invalid-view", path, "must be an object");
  return allowed === undefined ? value as Record<string, unknown> : exact(value as Record<string, unknown>, path, allowed);
}

function exact(value: Record<string, unknown>, path: string, allowed: string[]): Record<string, unknown> {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) fail("invalid-view", `${path}.${key}`, "unknown field");
  return value;
}

function text(value: unknown, path: string, context: ValidationContext, maxBytes: number, empty = false): string {
  if (typeof value !== "string" || (!empty && value.length === 0) || hasUnsafeControl(value)) fail("invalid-view", path, "must be bounded text");
  const size = bytes(value);
  if (size > maxBytes) fail("view-capacity", path, `text exceeds ${maxBytes} bytes`);
  context.textBytes += size;
  if (context.textBytes > context.limits.maxTextBytes) fail("view-capacity", path, "aggregate text exceeds maxTextBytes");
  return value;
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail("invalid-view", path, "must be an identifier");
  return value;
}

function languageName(value: unknown, path: string): string {
  if (typeof value !== "string" || !LANGUAGE.test(value)) fail("invalid-view", path, "must be a language identifier");
  return value;
}

function opaqueBlobRef(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^blob:[A-Za-z0-9][A-Za-z0-9._:-]{0,250}$/u.test(value)) fail("invalid-view", path, "must be an opaque authorized blob reference");
  return value;
}

function actionReference(value: unknown, path: string, context: ValidationContext): string {
  const actionId = identifier(value, path);
  if (context.actionReferences.has(actionId)) fail("invalid-view", path, "action ID is rendered more than once");
  context.actionReferences.add(actionId);
  return actionId;
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail("invalid-view", path, `must be an integer between ${min} and ${max}`);
  return value as number;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail("invalid-view", path, "must be a boolean");
  return value;
}

function enumeration<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) fail("invalid-view", path, `must be one of ${values.join(", ")}`);
  return value as T;
}

function jsonBytes(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail("invalid-view", "$", "must be JSON-serializable");
    return bytes(encoded);
  } catch (error) {
    if (error instanceof ExtensionViewValidationError) throw error;
    fail("invalid-view", "$", "must be JSON-serializable");
  }
}

function bytes(value: string): number {
  return decoder.encode(value).byteLength;
}

function hasUnsafeControl(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function fail(code: ExtensionViewValidationError["code"], path: string, message: string): never {
  throw new ExtensionViewValidationError(code, path, message);
}
