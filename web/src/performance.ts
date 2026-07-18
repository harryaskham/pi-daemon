export interface DashMetricSnapshot {
  generatedAt: string;
  fixtureSessions: number;
  visibleSessionRows: number;
  visibleTranscriptRows: number;
  firstRowsMs?: number;
  navigationFirstRowsMs?: number;
  lastSearchMs?: number;
  maxFrameWorkMs?: number;
  frameWorkSamples: number[];
  heapBytes?: number;
}

const snapshot: DashMetricSnapshot = {
  generatedAt: new Date().toISOString(),
  fixtureSessions: 0,
  visibleSessionRows: 0,
  visibleTranscriptRows: 0,
  frameWorkSamples: [],
};

function publish(): void {
  if (typeof window === "undefined") return;
  const memory = (
    performance as Performance & {
      memory?: { usedJSHeapSize?: number };
    }
  ).memory;
  const heapBytes = memory?.usedJSHeapSize;
  window.__DASH_METRICS__ = {
    ...snapshot,
    ...(heapBytes === undefined ? {} : { heapBytes }),
    frameWorkSamples: [...snapshot.frameWorkSamples],
  };
}

export function setFixtureCount(count: number): void {
  snapshot.fixtureSessions = count;
  publish();
}

export function markFirstRows(): void {
  if (snapshot.firstRowsMs !== undefined) return;
  const now = performance.now();
  const moduleReady = performance.getEntriesByName("dash:module-ready").at(-1);
  snapshot.firstRowsMs = Number((now - (moduleReady?.startTime ?? 0)).toFixed(2));
  snapshot.navigationFirstRowsMs = Number(now.toFixed(2));
  snapshot.visibleSessionRows = document.querySelectorAll("[data-session-row]").length;
  snapshot.visibleTranscriptRows = document.querySelectorAll("[data-transcript-row]").length;
  publish();
}

export function recordSearch(durationMs: number): void {
  snapshot.lastSearchMs = Number(durationMs.toFixed(3));
  publish();
}

export function recordFrameWork(durationMs: number): void {
  const rounded = Number(durationMs.toFixed(3));
  snapshot.frameWorkSamples.push(rounded);
  if (snapshot.frameWorkSamples.length > 120) snapshot.frameWorkSamples.shift();
  snapshot.maxFrameWorkMs = Math.max(snapshot.maxFrameWorkMs ?? 0, rounded);
  publish();
}

export function readMetrics(): DashMetricSnapshot {
  publish();
  return {
    ...snapshot,
    frameWorkSamples: [...snapshot.frameWorkSamples],
  };
}
