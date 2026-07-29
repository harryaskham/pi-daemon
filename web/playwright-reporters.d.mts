/** Path, relative to the web workspace, of the structured run record. */
export declare const RUN_RECORD_FILE: string;

/**
 * Reporters for the Dash browser suite: readable progress plus a durable
 * machine-readable record.
 */
export declare function dashReporters(
  outputFile?: string,
): Array<[string] | [string, Record<string, unknown>]>;
