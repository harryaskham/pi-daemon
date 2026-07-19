import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HOST_TOOL_NAMES,
  HostToolAdapterError,
  HostToolAdapterRegistry,
  createHostToolDefinitions,
} from "../dist/tool-adapter-runtime.js";
import { parseHostToolAdapterMessage } from "../dist/tool-adapter-protocol.js";

const capabilityHandle = "A".repeat(43);

function descriptor(socketPath, overrides = {}) {
  const limits = {
    maxRequestBytes: 16 * 1024,
    maxResponseBytes: 16 * 1024,
    maxConcurrentRequests: 2,
    maxQueuedRequests: 2,
    requestTimeoutMs: 500,
    maxIdempotencyKeys: 16,
    idempotencyTtlMs: 5_000,
    ...(overrides.limits ?? {}),
  };
  return {
    protocolVersion: "1.0",
    adapterId: "fixture-adapter",
    adapterVersion: "1.2.3",
    endpoint: { transport: "unix", path: socketPath },
    binding: {
      hostInstanceId: "host-fixture",
      sessionId: "session-fixture",
      generation: 7,
      capabilityHandle,
    },
    operations: overrides.operations ?? [
      "fs.list",
      "fs.stat",
      "fs.read",
      "fs.search",
      "fs.write",
      "fs.edit",
    ],
    limits,
  };
}

function commonFrame(input, kind) {
  return {
    protocolVersion: "1.0",
    kind,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    hostInstanceId: input.binding.hostInstanceId,
    sessionId: input.binding.sessionId,
    generation: input.binding.generation,
  };
}

async function harness(t, options = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "pi-daemon-tool-adapter-")),
  );
  const cwd = join(root, "cwd");
  const socketDir = join(root, "socket");
  const socketPath = join(socketDir, "adapter.sock");
  await Promise.all([
    mkdir(cwd, { mode: 0o700 }),
    mkdir(socketDir, { mode: 0o700 }),
  ]);
  const input = descriptor(socketPath, options.descriptor);
  const frames = [];
  const sockets = new Set();
  const send = (socket, value) => socket.write(`${JSON.stringify(value)}\n`);
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      pending += chunk;
      while (true) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.length === 0) continue;
        const frame = JSON.parse(line);
        frames.push(frame);
        if (options.onFrame !== undefined) {
          options.onFrame({ frame, socket, send, input, frames });
          continue;
        }
        if (frame.kind === "bind") {
          send(socket, {
            ...commonFrame(input, "bound"),
            operations: input.operations,
            limits: input.limits,
          });
        } else if (frame.kind === "invoke") {
          send(socket, {
            ...commonFrame(input, "result"),
            requestId: frame.requestId,
            idempotencyKey: frame.idempotencyKey,
            operation: frame.operation,
            ok: true,
            data: validResultData(frame.operation, frame.payload),
          });
        } else if (frame.kind === "abort") {
          send(socket, {
            ...commonFrame(input, "aborted"),
            requestId: frame.requestId,
            targetRequestId: frame.targetRequestId,
            aborted: true,
          });
        } else if (frame.kind === "revoke") {
          send(socket, commonFrame(input, "revoked"));
        }
      }
    });
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(socketPath, resolvePromise);
  });
  await chmod(socketPath, options.socketMode ?? 0o600);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, cwd, socketDir, socketPath, input, frames, send, server };
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
  }
}

function validResultData(operation, payload) {
  switch (operation) {
    case "fs.list":
      return { entries: [], truncated: false };
    case "fs.stat":
      return { type: "directory", size: 0 };
    case "fs.read":
      return { content: "", bytesRead: 0, eof: true };
    case "fs.search":
      return { matches: [], truncated: false };
    case "fs.write":
      return { created: true, bytesWritten: Buffer.byteLength(payload.content), digest: "a".repeat(64) };
    case "fs.edit":
      return { replacements: payload.edits.length, digest: "a".repeat(64) };
    default:
      throw new Error(`unknown operation ${operation}`);
  }
}

function responseFor(input, frame, data) {
  return {
    ...commonFrame(input, "result"),
    requestId: frame.requestId,
    idempotencyKey: frame.idempotencyKey,
    operation: frame.operation,
    ok: true,
    data,
  };
}

test("registry binds one private session socket, multiplexes requests and revokes on dispose", async (t) => {
  const fixture = await harness(t);
  const registry = new HostToolAdapterRegistry();
  const session = await registry.open(fixture.input, { cwd: fixture.cwd });
  assert.equal(registry.size, 1);
  const result = await session.invoke("fs.stat", { path: "." }, { idempotencyKey: "stat-1" });
  assert.deepEqual(result, { type: "directory", size: 0 });
  await session.dispose();
  await waitFor(() => fixture.frames.some((frame) => frame.kind === "revoke"), "revoke frame");
  assert.equal(registry.size, 0);
  assert.equal(fixture.frames[0].kind, "bind");
  assert.equal(fixture.frames[0].capabilityHandle, capabilityHandle);
  assert.equal(
    fixture.frames.slice(1).some((frame) => JSON.stringify(frame).includes(capabilityHandle)),
    false,
  );
  await registry.dispose();
});

test("client enforces concurrent and queued request limits without unbounded writes", async (t) => {
  const held = [];
  const fixture = await harness(t, {
    descriptor: {
      limits: { maxConcurrentRequests: 1, maxQueuedRequests: 1 },
      operations: ["fs.stat"],
    },
    onFrame({ frame, socket, send, input }) {
      if (frame.kind === "bind") {
        send(socket, {
          ...commonFrame(input, "bound"),
          operations: input.operations,
          limits: input.limits,
        });
      } else if (frame.kind === "invoke") {
        held.push({ frame, socket, send, input });
      }
    },
  });
  const registry = new HostToolAdapterRegistry();
  const session = await registry.open(fixture.input, { cwd: fixture.cwd });
  const first = session.invoke("fs.stat", { path: "one" }, { idempotencyKey: "one" });
  await waitFor(() => held.length === 1, "first invoke");
  const second = session.invoke("fs.stat", { path: "two" }, { idempotencyKey: "two" });
  await assert.rejects(
    session.invoke("fs.stat", { path: "three" }, { idempotencyKey: "three" }),
    (error) => error instanceof HostToolAdapterError && error.code === "adapter_queue_capacity",
  );
  assert.equal(session.activeRequests, 1);
  assert.equal(session.queuedRequests, 1);
  held[0].send(
    held[0].socket,
    responseFor(held[0].input, held[0].frame, { type: "file", size: 1 }),
  );
  assert.deepEqual(await first, { type: "file", size: 1 });
  await waitFor(() => held.length === 2, "second invoke");
  held[1].send(
    held[1].socket,
    responseFor(held[1].input, held[1].frame, { type: "file", size: 2 }),
  );
  assert.deepEqual(await second, { type: "file", size: 2 });
  await session.dispose();
});

test("AbortSignal emits a targeted abort without tearing down other multiplexed work", async (t) => {
  let held;
  const fixture = await harness(t, {
    descriptor: { operations: ["fs.read", "fs.stat"] },
    onFrame({ frame, socket, send, input }) {
      if (frame.kind === "bind") {
        send(socket, {
          ...commonFrame(input, "bound"),
          operations: input.operations,
          limits: input.limits,
        });
      } else if (frame.kind === "invoke" && frame.operation === "fs.read") {
        held = frame;
      } else if (frame.kind === "abort") {
        assert.equal(frame.targetRequestId, held.requestId);
        const response = {
          ...commonFrame(input, "aborted"),
          requestId: frame.requestId,
          targetRequestId: frame.targetRequestId,
          aborted: true,
        };
        parseHostToolAdapterMessage(response, input);
        send(socket, response);
      } else if (frame.kind === "invoke") {
        send(socket, responseFor(input, frame, { type: "file", size: 0 }));
      }
    },
  });
  const registry = new HostToolAdapterRegistry();
  const session = await registry.open(fixture.input, { cwd: fixture.cwd });
  const controller = new AbortController();
  const reading = session.invoke(
    "fs.read",
    { path: "file" },
    { idempotencyKey: "read-abort", signal: controller.signal },
  );
  await waitFor(() => held !== undefined, "held read");
  controller.abort();
  await assert.rejects(
    reading,
    (error) =>
      error instanceof HostToolAdapterError &&
      error.code === "adapter_request_aborted" &&
      error.indeterminate,
  );
  await waitFor(() => fixture.frames.some((frame) => frame.kind === "abort"), "abort frame");
  assert.deepEqual(
    await session.invoke("fs.stat", { path: "file" }, { idempotencyKey: "stat-after-abort" }),
    { type: "file", size: 0 },
  );
  await session.dispose();
});

test("shared parser rejects malformed outbound payloads and inbound results", async (t) => {
  const fixture = await harness(t, {
    descriptor: { operations: ["fs.write", "fs.stat"] },
    onFrame({ frame, socket, send, input }) {
      if (frame.kind === "bind") {
        send(socket, {
          ...commonFrame(input, "bound"),
          operations: input.operations,
          limits: input.limits,
        });
      } else if (frame.kind === "invoke") {
        send(socket, responseFor(input, frame, { type: "file" }));
      }
    },
  });
  const registry = new HostToolAdapterRegistry();
  const session = await registry.open(fixture.input, { cwd: fixture.cwd });
  await assert.rejects(
    session.invoke(
      "fs.write",
      { path: "file", content: "x", expectedDigest: "not-a-digest" },
      { idempotencyKey: "invalid-write" },
    ),
    (error) =>
      error instanceof HostToolAdapterError && error.code === "adapter_request_invalid",
  );
  assert.equal(fixture.frames.filter((frame) => frame.kind === "invoke").length, 0);
  await assert.rejects(
    session.invoke("fs.stat", { path: "file" }, { idempotencyKey: "invalid-result" }),
    (error) =>
      error instanceof HostToolAdapterError && error.code === "adapter_protocol_invalid",
  );
  assert.equal(registry.size, 0);
});

test("response identity and capability reflection fail closed without exposing secrets", async (t) => {
  const fixture = await harness(t, {
    descriptor: { operations: ["fs.stat"] },
    onFrame({ frame, socket, send, input }) {
      if (frame.kind === "bind") {
        send(socket, {
          ...commonFrame(input, "bound"),
          operations: input.operations,
          limits: input.limits,
        });
      } else if (frame.kind === "invoke") {
        send(socket, {
          ...responseFor(input, frame, null),
          ok: false,
          error: {
            code: "bad",
            message: `leak:${capabilityHandle}`,
            retryable: false,
          },
        });
      }
    },
  });
  const registry = new HostToolAdapterRegistry();
  const session = await registry.open(fixture.input, { cwd: fixture.cwd });
  await assert.rejects(
    session.invoke("fs.stat", { path: "." }, { idempotencyKey: "secret-response" }),
    (error) => {
      assert.equal(error instanceof HostToolAdapterError, true);
      assert.equal(error.code, "adapter_secret_reflected");
      assert.equal(String(error).includes(capabilityHandle), false);
      assert.equal(String(error).includes(fixture.socketPath), false);
      return true;
    },
  );
  assert.equal(registry.size, 0);
});

test("root-relative normalization rejects traversal, symlinks and missing parents", async (t) => {
  const fixture = await harness(t, { descriptor: { operations: ["fs.read", "fs.write"] } });
  await mkdir(join(fixture.cwd, "dir"), { mode: 0o700 });
  await writeFile(join(fixture.cwd, "dir", "file.txt"), "fixture");
  await symlink(join(fixture.cwd, "dir", "file.txt"), join(fixture.cwd, "link.txt"));
  const registry = new HostToolAdapterRegistry();
  const session = await registry.open(fixture.input, { cwd: fixture.cwd });
  assert.equal(await session.normalizePath("dir/file.txt"), "dir/file.txt");
  assert.equal(
    await session.normalizePath("dir/new.txt", { allowMissingLeaf: true }),
    "dir/new.txt",
  );
  for (const path of [
    "",
    "../outside",
    "/absolute",
    "dir//file.txt",
    "dir/./file.txt",
    "link.txt",
    "missing/file.txt",
  ]) {
    await assert.rejects(session.normalizePath(path), HostToolAdapterError, path);
  }
  await assert.rejects(
    session.normalizePath("missing/file.txt", { allowMissingLeaf: true }),
    (error) => error instanceof HostToolAdapterError && error.code === "adapter_path_unavailable",
  );
  await session.dispose();
});

test("fixed provider-safe Pi tools map only to descriptor-approved wire operations", async (t) => {
  const fixture = await harness(t, {
    descriptor: { operations: ["fs.read", "fs.stat"] },
    onFrame({ frame, socket, send, input }) {
      if (frame.kind === "bind") {
        send(socket, {
          ...commonFrame(input, "bound"),
          operations: input.operations,
          limits: input.limits,
        });
      } else if (frame.kind === "invoke") {
        const data = frame.operation === "fs.read"
          ? { content: "remote content", bytesRead: 14, eof: true }
          : { type: "file", size: 14 };
        send(socket, responseFor(input, frame, data));
      }
    },
  });
  await writeFile(join(fixture.cwd, "file.txt"), "local content");
  const registry = new HostToolAdapterRegistry();
  const session = await registry.open(fixture.input, { cwd: fixture.cwd });
  const tools = createHostToolDefinitions(session);
  assert.deepEqual(tools.map((tool) => tool.name), [HOST_TOOL_NAMES["fs.read"], HOST_TOOL_NAMES["fs.stat"]]);
  const read = tools.find((tool) => tool.name === "fs_read");
  const result = await read.execute("tool-call-1", { path: "file.txt" }, undefined, undefined, {});
  assert.equal(result.content[0].text, "remote content");
  const invoke = fixture.frames.find((frame) => frame.kind === "invoke");
  assert.equal(invoke.operation, "fs.read");
  assert.deepEqual(invoke.payload, { path: "file.txt" });
  assert.match(invoke.idempotencyKey, /^tool-[a-f0-9]{64}$/);
  await session.dispose();
});

test("write and edit tools serialize the full invoke window per rooted path", async (t) => {
  const held = [];
  const fixture = await harness(t, {
    descriptor: { operations: ["fs.write"] },
    onFrame({ frame, socket, send, input }) {
      if (frame.kind === "bind") {
        send(socket, {
          ...commonFrame(input, "bound"),
          operations: input.operations,
          limits: input.limits,
        });
      } else if (frame.kind === "invoke") {
        held.push({ frame, socket, send, input });
      }
    },
  });
  const registry = new HostToolAdapterRegistry();
  const session = await registry.open(fixture.input, { cwd: fixture.cwd });
  const [write] = createHostToolDefinitions(session);
  const first = write.execute(
    "write-one",
    { path: "file.txt", content: "one" },
    undefined,
    undefined,
    {},
  );
  await waitFor(() => held.length === 1, "first write");
  const second = write.execute(
    "write-two",
    { path: "file.txt", content: "two" },
    undefined,
    undefined,
    {},
  );
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  assert.equal(held.length, 1);
  held[0].send(held[0].socket, responseFor(held[0].input, held[0].frame, {
    created: true,
    bytesWritten: 3,
    digest: "a".repeat(64),
  }));
  await first;
  await waitFor(() => held.length === 2, "second write");
  held[1].send(held[1].socket, responseFor(held[1].input, held[1].frame, {
    created: false,
    bytesWritten: 3,
    digest: "b".repeat(64),
  }));
  await second;
  await session.dispose();
});

test("large valid adapter results are bounded before entering Pi model context", async (t) => {
  const largeContent = `${"x".repeat(200)}\n`.repeat(400);
  const fixture = await harness(t, {
    descriptor: {
      operations: ["fs.read"],
      limits: { maxRequestBytes: 16 * 1024, maxResponseBytes: 128 * 1024 },
    },
    onFrame({ frame, socket, send, input }) {
      if (frame.kind === "bind") {
        send(socket, {
          ...commonFrame(input, "bound"),
          operations: input.operations,
          limits: input.limits,
        });
      } else if (frame.kind === "invoke") {
        send(socket, responseFor(input, frame, {
          content: largeContent,
          bytesRead: Buffer.byteLength(largeContent),
          eof: true,
        }));
      }
    },
  });
  await writeFile(join(fixture.cwd, "large.txt"), "fixture");
  const registry = new HostToolAdapterRegistry();
  const session = await registry.open(fixture.input, { cwd: fixture.cwd });
  const [read] = createHostToolDefinitions(session);
  const result = await read.execute(
    "large-read",
    { path: "large.txt" },
    undefined,
    undefined,
    {},
  );
  assert.equal(result.details.truncated, true);
  assert.equal(result.details.totalBytes, Buffer.byteLength(largeContent));
  assert.equal("content" in result.details, false);
  assert.ok(Buffer.byteLength(result.content[0].text, "utf8") < 52 * 1024);
  assert.match(result.content[0].text, /Output truncated/);
  await session.dispose();
});

test("permissive socket modes and oversized responses are rejected safely", async (t) => {
  const insecure = await harness(t, { socketMode: 0o666 });
  const registry = new HostToolAdapterRegistry();
  await assert.rejects(
    registry.open(insecure.input, { cwd: insecure.cwd }),
    (error) =>
      error instanceof HostToolAdapterError &&
      error.code === "adapter_endpoint_insecure" &&
      !String(error).includes(insecure.socketPath),
  );

  const oversized = await harness(t, {
    descriptor: {
      operations: ["fs.stat"],
      limits: { maxRequestBytes: 4096, maxResponseBytes: 1024 },
    },
    onFrame({ frame, socket, send, input }) {
      if (frame.kind === "bind") {
        send(socket, {
          ...commonFrame(input, "bound"),
          operations: input.operations,
          limits: input.limits,
        });
      } else if (frame.kind === "invoke") {
        socket.write(`${JSON.stringify({
          ...responseFor(input, frame, { text: "x".repeat(2_000) }),
        })}\n`);
      }
    },
  });
  const session = await registry.open(oversized.input, { cwd: oversized.cwd });
  await assert.rejects(
    session.invoke("fs.stat", { path: "." }, { idempotencyKey: "oversized" }),
    (error) => error instanceof HostToolAdapterError && error.code === "adapter_protocol_invalid",
  );
  assert.equal(registry.size, 0);
  await registry.dispose();
});
