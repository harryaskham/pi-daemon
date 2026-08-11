const MAX_MODEL_LABEL_CHARS = 256;

function modelPart(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, MAX_MODEL_LABEL_CHARS);
}

function formatModel(value: unknown, depth: number): string | undefined {
  const direct = modelPart(value);
  if (direct !== undefined) return direct;
  if (depth > 1 || typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const record = value as Record<string, unknown>;
  const provider = modelPart(record.provider);
  const id = modelPart(record.id) ?? modelPart(record.modelId) ?? modelPart(record.name);
  if (provider !== undefined && id !== undefined) {
    return id.startsWith(`${provider}/`) ? id : `${provider}/${id}`;
  }
  if (id !== undefined) return id;

  const nested = formatModel(record.model, depth + 1);
  if (provider !== undefined && nested !== undefined) {
    return nested.startsWith(`${provider}/`) ? nested : `${provider}/${nested}`;
  }
  return nested ?? provider;
}

/** Render an untrusted runtime/config model value without object coercion. */
export function modelLabel(value: unknown, fallback = "unknown"): string {
  return formatModel(value, 0) ?? fallback;
}
