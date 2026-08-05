import { stat } from "node:fs/promises";

import { PiDaemonClient } from "../dist/client.js";
import { redactCliDiagnostics } from "./cli-exit-diagnostics.mjs";

const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_DELAY_MS = 20;
const DEFAULT_CAPTURE_BYTES = 64 * 1024;
const RETRYABLE_SOCKET_ERRORS = new Set([
  "EAGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOENT",
  "EPIPE",
  "pi_daemon_client_timeout",
]);
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

class ChildStoppedError extends Error {
  constructor(detail) {
    super("daemon child stopped before semantic readiness");
    this.detail = detail;
  }
}

class ReadinessDeadlineError extends Error {
  constructor() {
    super("daemon semantic readiness deadline expired");
  }
}

function safeCode(value, fallback = "none") {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : fallback;
}

function errorCode(error) {
  return error instanceof Error && "code" in error ? safeCode(error.code, "unknown") : "unknown";
}

function boundedCapture(maxBytes) {
  let retained = Buffer.alloc(0);
  let totalBytes = 0;

  return {
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      totalBytes += buffer.byteLength;
      if (buffer.byteLength >= maxBytes) {
        retained = Buffer.from(buffer.subarray(buffer.byteLength - maxBytes));
        return;
      }
      const overflow = Math.max(0, retained.byteLength + buffer.byteLength - maxBytes);
      retained = Buffer.concat([retained.subarray(overflow), buffer]);
    },
    snapshot() {
      return {
        text: retained.toString("utf8"),
        capturedBytes: retained.byteLength,
        droppedBytes: totalBytes - retained.byteLength,
      };
    },
  };
}

/**
 * Retain a bounded tail of child stdout/stderr for assertions while exposing only
 * allow-listed structured fields in failure diagnostics. Raw process output can
 * contain paths, prompts, or credentials and must never be interpolated into an
 * assertion error.
 */
export function captureChildOutput(child, { maxBytesPerStream = DEFAULT_CAPTURE_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytesPerStream) || maxBytesPerStream < 1) {
    throw new Error("maxBytesPerStream must be a positive safe integer");
  }
  const stdout = boundedCapture(maxBytesPerStream);
  const stderr = boundedCapture(maxBytesPerStream);
  child.stdout?.on("data", (chunk) => stdout.append(chunk));
  child.stderr?.on("data", (chunk) => stderr.append(chunk));

  const snapshot = () => ({ stdout: stdout.snapshot(), stderr: stderr.snapshot() });
  return {
    snapshot,
    text() {
      const current = snapshot();
      return `${current.stdout.text}${current.stderr.text}`;
    },
    diagnostics() {
      const current = snapshot();
      return [
        `stdoutCapturedBytes=${current.stdout.capturedBytes}`,
        `stdoutDroppedBytes=${current.stdout.droppedBytes}`,
        `stderrCapturedBytes=${current.stderr.capturedBytes}`,
        `stderrDroppedBytes=${current.stderr.droppedBytes}`,
        `stderr=${redactCliDiagnostics(current.stderr.text)}`,
      ].join(" ");
    },
  };
}

function observeChild(child) {
  let settled = false;
  let resolveExit;
  const promise = new Promise((resolve) => { resolveExit = resolve; });
  const finish = (detail) => {
    if (settled) return;
    settled = true;
    resolveExit(detail);
  };
  const onExit = (code, signal) => finish({
    kind: "exit",
    exitCode: Number.isSafeInteger(code) ? code : null,
    signal: safeCode(signal),
  });
  const onError = (error) => finish({
    kind: "spawn_error",
    exitCode: null,
    signal: "none",
    errorCode: errorCode(error),
  });
  child.once("exit", onExit);
  child.once("error", onError);
  if (child.exitCode !== null || child.signalCode !== null) {
    onExit(child.exitCode, child.signalCode);
  }
  return {
    promise,
    dispose() {
      child.off("exit", onExit);
      child.off("error", onError);
    },
  };
}

async function raceAttempt(action, childExit, remainingMs) {
  let timer;
  try {
    return await Promise.race([
      action,
      childExit.then((detail) => { throw new ChildStoppedError(detail); }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ReadinessDeadlineError()), remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function delayOrChildExit(milliseconds, childExit) {
  let timer;
  try {
    await Promise.race([
      new Promise((resolve) => { timer = setTimeout(resolve, milliseconds); }),
      childExit.then((detail) => { throw new ChildStoppedError(detail); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function socketState(socketPath) {
  try {
    return (await stat(socketPath)).isSocket() ? "socket" : "not_socket";
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT" ? "missing" : `stat_error_${code}`;
  }
}

async function readinessError({
  reason,
  socketPath,
  attempts,
  startedAt,
  lastSocketError,
  childDetail,
  diagnostics,
}) {
  const elapsedMs = Date.now() - startedAt;
  const detail = childDetail ?? {};
  const safeDiagnostics = typeof diagnostics === "function"
    ? diagnostics()
    : "stdoutCapturedBytes=0 stdoutDroppedBytes=0 stderrCapturedBytes=0 stderrDroppedBytes=0 stderr=(not captured)";
  return new Error([
    "daemon semantic readiness failed",
    `reason=${reason}`,
    `attempts=${attempts}`,
    `elapsedMs=${elapsedMs}`,
    `expectedSocketState=${await socketState(socketPath)}`,
    `lastSocketError=${safeCode(lastSocketError)}`,
    `childKind=${safeCode(detail.kind)}`,
    `childExitCode=${Number.isSafeInteger(detail.exitCode) ? detail.exitCode : "none"}`,
    `childSignal=${safeCode(detail.signal)}`,
    `childErrorCode=${safeCode(detail.errorCode)}`,
    safeDiagnostics,
  ].join("; "));
}

/**
 * Wait until the exact daemon socket answers a protocol handshake.
 *
 * Socket-path existence is diagnostic only: a Unix socket inode can become
 * visible before a client can connect, or can be left behind by a crashed
 * process. Connection refusals are retried within one bounded deadline, while a
 * successful connection that gives a non-protocol response fails closed. Child
 * exit/spawn failure is raced against every connect, handshake, and retry wait.
 */
export async function waitForDaemonReady({
  socketPath,
  child,
  timeoutMs = DEFAULT_READY_TIMEOUT_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  handshakeRequestId = "daemon-readiness",
  diagnostics,
  connect = (options) => PiDaemonClient.connect(options),
}) {
  if (typeof socketPath !== "string" || socketPath.length === 0) {
    throw new Error("socketPath must be a non-empty string");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1) {
    throw new Error("retryDelayMs must be a positive safe integer");
  }

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const childExit = observeChild(child);
  let attempts = 0;
  let lastSocketError = "none";

  try {
    while (Date.now() < deadline) {
      attempts += 1;
      let client;
      try {
        const remainingBeforeConnect = Math.max(1, deadline - Date.now());
        client = await raceAttempt(
          connect({
            socketPath,
            connectTimeoutMs: Math.min(5_000, remainingBeforeConnect),
            requestTimeoutMs: remainingBeforeConnect,
          }),
          childExit.promise,
          remainingBeforeConnect,
        );
        const remainingBeforeHandshake = Math.max(1, deadline - Date.now());
        await raceAttempt(
          client.handshake(handshakeRequestId),
          childExit.promise,
          remainingBeforeHandshake,
        );
        return client;
      } catch (error) {
        client?.close();
        if (error instanceof ChildStoppedError) {
          throw await readinessError({
            reason: "child_stopped",
            socketPath,
            attempts,
            startedAt,
            lastSocketError,
            childDetail: error.detail,
            diagnostics,
          });
        }
        if (error instanceof ReadinessDeadlineError) {
          throw await readinessError({
            reason: "deadline",
            socketPath,
            attempts,
            startedAt,
            lastSocketError,
            diagnostics,
          });
        }
        const code = errorCode(error);
        if (!RETRYABLE_SOCKET_ERRORS.has(code)) {
          throw await readinessError({
            reason: "semantic_probe_rejected",
            socketPath,
            attempts,
            startedAt,
            lastSocketError: code,
            diagnostics,
          });
        }
        lastSocketError = code;
      }

      const remainingBeforeRetry = deadline - Date.now();
      if (remainingBeforeRetry <= 0) break;
      try {
        await delayOrChildExit(
          Math.min(retryDelayMs, remainingBeforeRetry),
          childExit.promise,
        );
      } catch (error) {
        if (!(error instanceof ChildStoppedError)) throw error;
        throw await readinessError({
          reason: "child_stopped",
          socketPath,
          attempts,
          startedAt,
          lastSocketError,
          childDetail: error.detail,
          diagnostics,
        });
      }
    }

    throw await readinessError({
      reason: "deadline",
      socketPath,
      attempts,
      startedAt,
      lastSocketError,
      diagnostics,
    });
  } finally {
    childExit.dispose();
  }
}
