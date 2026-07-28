import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DEFAULT_REMOTE_DASHBOARD_LIMITS,
  RemoteDashboardBackendError,
  assertIdentity,
  boundedJsonValue,
  boundedObject,
  decodeFrame,
  hubKey,
  indeterminate,
  localGap,
  reconnectDelay,
  rejected,
  remoteError,
  resolveLimits,
  sameDimensions,
} from "../dist/dashboard-remote-transport.js";
import * as remoteBackendModule from "../dist/dashboard-remote-backend.js";
import { RemoteRichHub } from "../dist/dashboard-remote-rich-hub.js";
import { RemoteTuiHub } from "../dist/dashboard-remote-tui-hub.js";
import { SessionApiClientError } from "../dist/session-client.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const identity = { hostInstanceId: "host-1", sessionId: "session-1", generation: 3 };

test("splitting the transport preserves the published remote backend export surface", async () => {
  assert.deepEqual(Object.keys(remoteBackendModule).sort(), [
    "DEFAULT_REMOTE_DASHBOARD_LIMITS",
    "RemoteDashboardBackend",
    "RemoteDashboardBackendError",
  ]);
  assert.equal(remoteBackendModule.RemoteDashboardBackendError, RemoteDashboardBackendError);
  assert.equal(
    remoteBackendModule.DEFAULT_REMOTE_DASHBOARD_LIMITS,
    DEFAULT_REMOTE_DASHBOARD_LIMITS,
  );
  assert.equal(typeof RemoteRichHub, "function");
  assert.equal(typeof RemoteTuiHub, "function");
});

test("the internal transport modules stay off the package export map", async () => {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(manifest.exports["./dashboard-remote-backend"].import, "./dist/dashboard-remote-backend.js");
  for (const internal of [
    "./dashboard-remote-transport",
    "./dashboard-remote-rich-hub",
    "./dashboard-remote-tui-hub",
  ]) {
    assert.equal(internal in manifest.exports, false);
  }
});

test("remote limits reject non-positive and inverted reconnect bounds", () => {
  assert.deepEqual(resolveLimits(undefined), DEFAULT_REMOTE_DASHBOARD_LIMITS);
  assert.equal(resolveLimits({ maxRichHubs: 2 }).maxRichHubs, 2);
  assert.throws(() => resolveLimits({ maxRichHubs: 0 }), /maxRichHubs must be a positive safe integer/);
  assert.throws(() => resolveLimits({ maxTuiHubs: 1.5 }), /maxTuiHubs must be a positive safe integer/);
  assert.throws(
    () => resolveLimits({ reconnectBaseDelayMs: 5_000, reconnectMaxDelayMs: 100 }),
    /reconnectBaseDelayMs cannot exceed reconnectMaxDelayMs/,
  );
});

test("reconnect backoff grows exponentially and saturates at the configured ceiling", () => {
  const limits = { reconnectBaseDelayMs: 100, reconnectMaxDelayMs: 5_000 };
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => reconnectDelay(attempt, limits)),
    [100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000],
  );
  assert.equal(reconnectDelay(0, limits), 100);
});

test("frame decoding refuses binary payloads and frames above their bound", () => {
  assert.deepEqual(decodeFrame(Buffer.from('{"type":"ok"}'), false, 1_024), { type: "ok" });
  assert.throws(
    () => decodeFrame(Buffer.from("{}"), true, 1_024),
    (error) => error instanceof RemoteDashboardBackendError && error.code === "remote_protocol_error",
  );
  assert.throws(
    () => decodeFrame(Buffer.from('{"padding":"aaaaaaaaaa"}'), false, 8),
    (error) => error instanceof RemoteDashboardBackendError && error.code === "remote_frame_too_large",
  );
  assert.throws(
    () => decodeFrame(42, false, 1_024),
    (error) => error instanceof RemoteDashboardBackendError && error.code === "remote_protocol_error",
  );
});

test("bounded JSON projection truncates oversized values without throwing", () => {
  assert.equal(boundedJsonValue(undefined), undefined);
  assert.deepEqual(boundedJsonValue({ ok: true }, 1_024), { ok: true });
  assert.deepEqual(boundedJsonValue("x".repeat(64), 8), { type: "bounded_output", truncated: true });
  assert.deepEqual(boundedObject("scalar", 1_024), { value: "scalar" });
  assert.deepEqual(boundedObject(undefined, 1_024), { value: null });
});

test("command result helpers keep the neutral rejected and indeterminate shapes", () => {
  assert.deepEqual(rejected("corr-1", "remote_denied", "denied"), {
    correlationId: "corr-1",
    state: "rejected",
    error: { code: "remote_denied", message: "denied", retryable: false },
  });
  assert.deepEqual(indeterminate("corr-2", "connection lost"), {
    correlationId: "corr-2",
    state: "indeterminate",
    error: {
      code: "connection_lost_indeterminate",
      message: "connection lost",
      retryable: false,
    },
  });
});

test("local replay gaps always request a follow-up snapshot", () => {
  assert.deepEqual(localGap(identity, "cursor-a", "cursor-b"), {
    kind: "replay_gap",
    identity,
    reason: "cursor-expired",
    requestedCursor: "cursor-a",
    highWaterCursor: "cursor-b",
    snapshotFollows: true,
  });
});

test("identity assertions reject any stale generation, session, or host", () => {
  assert.equal(assertIdentity({ ...identity }, identity), undefined);
  for (const stale of [
    { ...identity, generation: 4 },
    { ...identity, sessionId: "session-2" },
    { ...identity, hostInstanceId: "host-2" },
  ]) {
    assert.throws(
      () => assertIdentity(stale, identity),
      (error) => error instanceof RemoteDashboardBackendError && error.code === "stale_generation",
    );
  }
});

test("client errors map onto the remote taxonomy while preserving retryability", () => {
  const typed = new RemoteDashboardBackendError("remote_denied", "denied");
  assert.equal(remoteError(typed), typed);

  const client = remoteError(
    new SessionApiClientError(503, {
      code: "session_api_unavailable",
      message: "upstream down",
      retryable: true,
    }),
  );
  assert.equal(client instanceof RemoteDashboardBackendError, true);
  assert.equal(client.code, "session_api_unavailable");
  assert.equal(client.retryable, true);

  const unknown = remoteError(new Error("boom"));
  assert.equal(unknown.code, "remote_unavailable");
  assert.equal(unknown.retryable, true);
  assert.equal(unknown.message, "boom");
});

test("hub keys and TUI dimensions compare without separator collisions", () => {
  assert.equal(hubKey("session-1", 2), hubKey("session-1", 2));
  assert.notEqual(hubKey("session-1", 2), hubKey("session-1", 3));
  assert.notEqual(hubKey("session-1", 2), hubKey("session-12", 2));
  assert.equal(sameDimensions({ rows: 24, columns: 80 }, { rows: 24, columns: 80 }), true);
  assert.equal(sameDimensions({ rows: 24, columns: 80 }, { rows: 25, columns: 80 }), false);
  assert.equal(sameDimensions({ rows: 24, columns: 80 }, { rows: 24, columns: 81 }), false);
});
