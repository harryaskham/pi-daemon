import assert from "node:assert/strict";
import test from "node:test";

import { assertCliExitCode, redactCliDiagnostics } from "./cli-exit-diagnostics.mjs";

const BEARER = "fixture-service-bearer-0123456789";
const TEMPORARY_ROOT = "/var/folders/zz/pi-daemon-api-cli-abc123";

test("redacted CLI diagnostics surface structured codes without secret material", () => {
  const chunks = [
    `${JSON.stringify({
      timestamp: "2026-07-28T12:00:00.000Z",
      level: "info",
      event: "pi_daemon_ready",
      api: { enabled: true, host: "::1", port: 51234, token: BEARER },
      stateDir: TEMPORARY_ROOT,
    })}\n`,
    `${JSON.stringify({
      error: {
        status: 413,
        code: "outbound_record_too_large",
        message: `record for ${TEMPORARY_ROOT} exceeded the bound`,
        retryable: false,
      },
    })}\n`,
    `${JSON.stringify({
      timestamp: "2026-07-28T12:00:01.000Z",
      level: "error",
      event: "pi_daemon_fatal",
      errorCode: "host_start_failed",
      message: `failed to bind ${TEMPORARY_ROOT}/daemon.sock`,
    })}\n`,
  ];

  const summary = redactCliDiagnostics(chunks);

  assert.match(summary, /error\.code=outbound_record_too_large/);
  assert.match(summary, /error\.status=413/);
  assert.match(summary, /event=pi_daemon_fatal/);
  assert.match(summary, /errorCode=host_start_failed/);
  assert.equal(summary.includes(BEARER), false);
  assert.equal(summary.includes(TEMPORARY_ROOT), false);
  assert.equal(summary.includes("exceeded the bound"), false);
  assert.equal(summary.includes("failed to bind"), false);
  assert.equal(summary.includes("51234"), false);
});

test("redacted CLI diagnostics never echo unstructured or free-text lines", () => {
  const chunks = [
    "unknown command: serv\nRun 'pi-daemon help' for usage.\n",
    `${JSON.stringify({ event: "pi daemon ready with spaces", note: `see ${TEMPORARY_ROOT}` })}\n`,
    `${JSON.stringify({ prompt: "please summarise the private transcript" })}\n`,
  ];

  const summary = redactCliDiagnostics(chunks);

  assert.equal(summary.includes("unknown command"), false);
  assert.equal(summary.includes("pi-daemon help"), false);
  assert.equal(summary.includes("private transcript"), false);
  assert.equal(summary.includes(TEMPORARY_ROOT), false);
  assert.equal(summary.includes("pi daemon ready with spaces"), false);
  assert.match(summary, /4 redacted non-structured line\(s\)/);
});

test("redacted CLI diagnostics stay bounded and deduplicated", () => {
  const chunks = Array.from({ length: 40 }, (_, index) =>
    `${JSON.stringify({ event: "pi_daemon_metric", code: `code_${index}` })}\n`,
  );
  chunks.push(`${JSON.stringify({ event: "pi_daemon_metric", code: "code_0" })}\n`);

  const summary = redactCliDiagnostics(chunks);
  const shown = summary.match(/\[event=pi_daemon_metric code=code_\d+\]/g) ?? [];

  assert.equal(shown.length, 12);
  assert.equal(new Set(shown).size, shown.length);
  assert.match(summary, /\(\+28 earlier redacted records\)/);
  assert.ok(summary.length < 1_024);
});

test("redacted CLI diagnostics report an explicit empty state", () => {
  assert.equal(redactCliDiagnostics([]), "(no structured diagnostics captured)");
  assert.equal(redactCliDiagnostics(""), "(no structured diagnostics captured)");
});

test("assertCliExitCode passes silently on a match and reports redacted context otherwise", () => {
  assertCliExitCode(0, 0, [`${JSON.stringify({ event: "pi_daemon_ready", token: BEARER })}\n`]);

  assert.throws(
    () =>
      assertCliExitCode(
        1,
        0,
        [
          `${JSON.stringify({
            error: { code: "outbound_record_too_large", message: TEMPORARY_ROOT },
          })}\n`,
        ],
        "serve ephemeral loopback API",
      ),
    (error) => {
      assert.match(error.message, /pi-daemon CLI \(serve ephemeral loopback API\) exited 1, expected 0/);
      assert.match(error.message, /error\.code=outbound_record_too_large/);
      assert.equal(error.message.includes(TEMPORARY_ROOT), false);
      return true;
    },
  );
});
