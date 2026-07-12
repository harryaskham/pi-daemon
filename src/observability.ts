export type LogLevel = "debug" | "info" | "warn" | "error";

export interface StructuredLogger {
  write(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
}

export interface MetricSummary {
  count: number;
  sum: number;
  min: number;
  max: number;
  last: number;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  summaries: Record<string, MetricSummary>;
}

export class HostMetrics {
  readonly #counters = new Map<string, number>();
  readonly #summaries = new Map<string, MetricSummary>();

  increment(name: string, amount = 1): void {
    if (!Number.isFinite(amount)) throw new Error("metric increment must be finite");
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + amount);
  }

  observe(name: string, value: number): void {
    if (!Number.isFinite(value)) throw new Error("metric observation must be finite");
    const current = this.#summaries.get(name);
    if (current === undefined) {
      this.#summaries.set(name, { count: 1, sum: value, min: value, max: value, last: value });
      return;
    }
    current.count += 1;
    current.sum += value;
    current.min = Math.min(current.min, value);
    current.max = Math.max(current.max, value);
    current.last = value;
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries([...this.#counters.entries()].sort(([a], [b]) => a.localeCompare(b))),
      summaries: Object.fromEntries(
        [...this.#summaries.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, summary]) => [name, { ...summary }]),
      ),
    };
  }
}

export class JsonLineLogger implements StructuredLogger {
  readonly #writeLine: (line: string) => void;
  readonly #base: Record<string, unknown>;

  constructor(
    writeLine: (line: string) => void = (line) => process.stderr.write(line),
    base: Record<string, unknown> = {},
  ) {
    this.#writeLine = writeLine;
    this.#base = sanitizeLogFields(base);
  }

  write(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    this.#writeLine(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        ...this.#base,
        ...sanitizeLogFields(fields),
      })}\n`,
    );
  }
}

export const NOOP_LOGGER: StructuredLogger = {
  write: () => {},
};

const SENSITIVE_KEY =
  /(^|_)(prompt|content|text|result|output|token|secret|password|authorization|cookie|api[_-]?key|env)(_|$)/i;

export function sanitizeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  return sanitizeRecord(fields, 0);
}

function sanitizeRecord(fields: Record<string, unknown>, depth: number): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields)
      .slice(0, 64)
      .map(([key, value]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[redacted]" : sanitizeValue(value, depth + 1),
      ]),
  );
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth >= 4) return "[truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length <= 512 ? value : `${value.slice(0, 512)}…`;
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === "object") return sanitizeRecord(value as Record<string, unknown>, depth);
  return String(value);
}
