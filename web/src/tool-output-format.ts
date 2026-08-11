const MAX_JSON_PREVIEW_CHARS = 20_000;
const JSON_PREVIEW_SUFFIX = "\n… bounded JSON preview";

/** Pretty-print one complete JSON object/array without interpreting mixed shell output. */
export function prettyJsonToolOutput(text: string): string | undefined {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== "object" || value === null) return undefined;
    const formatted = JSON.stringify(value, null, 2);
    if (formatted.length <= MAX_JSON_PREVIEW_CHARS) return formatted;
    return `${formatted.slice(0, MAX_JSON_PREVIEW_CHARS - JSON_PREVIEW_SUFFIX.length)}${JSON_PREVIEW_SUFFIX}`;
  } catch {
    return undefined;
  }
}
