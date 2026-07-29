/**
 * Reporter set for the Dash browser suite.
 *
 * A failing local run used to be unclassifiable: the console scrolled past and
 * nothing survived it, so an incident could not be diagnosed after the fact even
 * by the person who saw it. CI already keeps `web/test-results` as an artifact
 * on failure; this gives a local run the same durable record.
 *
 * The record is JSON rather than teed console output. It captures each
 * scenario's error text structurally, which is what makes the next failure
 * self-classifying — a browser that dies at launch reports
 * `Target page, context or browser has been closed` against every scenario,
 * where a genuine assertion failure names the assertion — and it avoids ANSI
 * escapes, shell `pipefail` fragility, and interleaved output.
 *
 * Lives in a plain module so the wiring can be asserted structurally instead of
 * by matching source text.
 */

/** Path, relative to the web workspace, of the structured run record. */
export const RUN_RECORD_FILE = "test-results/run.json";

/**
 * Reporters for `playwright.config.ts`: readable progress on the terminal plus
 * the durable record beside the traces Playwright already writes on failure.
 *
 * @param {string} [outputFile]
 * @returns {Array<[string, Record<string, unknown>] | [string]>}
 */
export function dashReporters(outputFile = RUN_RECORD_FILE) {
  return [["list"], ["json", { outputFile }]];
}
