const MAX_DIAGNOSTIC_CHARS = 4_096;

export type TestDiagnosticWriter = (line: string) => unknown;

/**
 * Emit one diagnostic that remains visible for a passing Vitest test.
 *
 * Vitest's default reporter intercepts and hides `console.*` output from passing
 * tests. Direct stderr is intentionally not intercepted, so it is the supported
 * channel for measurements and other bounded diagnostics that must remain
 * visible in an ordinary `npm run web:test`. The injected writer keeps this
 * contract directly testable without changing global reporter configuration.
 */
export function reportTestDiagnostic(
  message: string,
  writer: TestDiagnosticWriter = defaultDiagnosticWriter,
): void {
  if (
    message.length === 0 ||
    message.length > MAX_DIAGNOSTIC_CHARS ||
    message.includes("\n") ||
    message.includes("\r") ||
    message.includes("\u0000")
  ) {
    throw new Error(`test diagnostic must be one bounded non-empty line (max ${MAX_DIAGNOSTIC_CHARS} characters)`);
  }
  writer(`${message}\n`);
}

function defaultDiagnosticWriter(line: string): unknown {
  if (typeof process !== "undefined" && typeof process.stderr?.write === "function") {
    return process.stderr.write(line);
  }
  console.info(line.trimEnd());
  return undefined;
}
