import { describe, expect, it, vi } from "vitest";
import { reportTestDiagnostic } from "./test-diagnostic";

describe("web test diagnostics", () => {
  it("writes one newline-terminated diagnostic through an injected channel", () => {
    const written: string[] = [];
    reportTestDiagnostic("fixture measurement: 12 rows", (line) => written.push(line));
    expect(written).toEqual(["fixture measurement: 12 rows\n"]);
  });

  it("uses stderr by default so passing-test diagnostics stay visible", () => {
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      reportTestDiagnostic("fixture diagnostic through stderr");
    } finally {
      stderr.mockRestore();
    }
    expect(written).toEqual(["fixture diagnostic through stderr\n"]);
  });

  it("refuses multiline, empty, NUL and oversized diagnostics", () => {
    for (const message of ["", "line one\nline two", "line one\rline two", "unsafe\u0000value", "x".repeat(4_097)]) {
      expect(() => reportTestDiagnostic(message, () => undefined)).toThrow(
        "test diagnostic must be one bounded non-empty line",
      );
    }
  });
});
