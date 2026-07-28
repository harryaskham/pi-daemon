import assert from "node:assert/strict";

/**
 * Shared, redaction-safe diagnostics for `runCli(...)` exit-code assertions (bd-f786ca).
 *
 * A failing `assert.equal(code, 0)` previously reported only `1 !== 0`, while the captured
 * stderr chunks already held the actionable structured code (for example
 * `outbound_record_too_large`). Passing raw log bodies into the assertion message is not an
 * acceptable fix: those lines can carry bearer tokens, temporary roots, prompts, and model
 * output. This helper extracts only allow-listed identifier-shaped fields and drops
 * everything else, so diagnosis is fast without weakening non-disclosure assertions.
 */

const SAFE_STRING = /^[A-Za-z0-9_.:-]{1,64}$/;
const SAFE_FIELDS = ["event", "level", "errorCode", "code", "reason", "phase"];
const SAFE_ERROR_FIELDS = ["code", "status", "retryable"];
const MAX_ENTRIES = 12;

function safeValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string" && SAFE_STRING.test(value)) return value;
  return undefined;
}

function describeRecord(record) {
  const parts = [];
  for (const field of SAFE_FIELDS) {
    const value = safeValue(record[field]);
    if (value !== undefined) parts.push(`${field}=${value}`);
  }
  const error = record.error;
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    for (const field of SAFE_ERROR_FIELDS) {
      const value = safeValue(error[field]);
      if (value !== undefined) parts.push(`error.${field}=${value}`);
    }
  }
  return parts.join(" ");
}

/**
 * Reduce captured CLI stderr/stdout chunks to a redacted single-line summary.
 *
 * @param {readonly string[] | string} chunks captured output chunks (may contain multiple lines each)
 * @returns {string} redacted summary containing only allow-listed identifier-shaped fields
 */
export function redactCliDiagnostics(chunks) {
  const lines = (Array.isArray(chunks) ? chunks : [chunks ?? ""])
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const descriptions = [];
  let unparsed = 0;
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      unparsed += 1;
      continue;
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      unparsed += 1;
      continue;
    }
    const described = describeRecord(record);
    if (described.length === 0) {
      unparsed += 1;
      continue;
    }
    if (!descriptions.includes(described)) descriptions.push(described);
  }
  const shown = descriptions.slice(-MAX_ENTRIES);
  const summary = [];
  if (shown.length > 0) summary.push(shown.map((entry) => `[${entry}]`).join(" "));
  if (descriptions.length > shown.length) {
    summary.push(`(+${descriptions.length - shown.length} earlier redacted records)`);
  }
  if (unparsed > 0) summary.push(`(${unparsed} redacted non-structured line(s))`);
  return summary.length > 0 ? summary.join(" ") : "(no structured diagnostics captured)";
}

/**
 * Assert a CLI exit code, reporting redacted structured diagnostics when it does not match.
 *
 * @param {number} actual exit code returned by `runCli`
 * @param {number} expected expected exit code
 * @param {readonly string[] | string} chunks captured stderr (and optionally stdout) chunks
 * @param {string} [context] optional short, secret-free context label
 */
export function assertCliExitCode(actual, expected, chunks, context) {
  if (actual === expected) return;
  const label = context === undefined ? "pi-daemon CLI" : `pi-daemon CLI (${context})`;
  assert.fail(
    `${label} exited ${actual}, expected ${expected}; redacted diagnostics: ${redactCliDiagnostics(chunks)}`,
  );
}
