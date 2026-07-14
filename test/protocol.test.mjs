import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  NdjsonDecoder,
  PROTOCOL_VERSION,
  ProtocolSerializationError,
  ProtocolValidationError,
  encodeBoundedLine,
  encodeLine,
  errorResponse,
  eventEnvelope,
  parseCommand,
  successResponse,
} from "../dist/protocol.js";

const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

test("language-neutral fixtures validate against protocol.schema.json", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../protocol.schema.json", import.meta.url), "utf8"),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  for (const name of [
    "handshake.command.json",
    "open.command.json",
    "wake.command.json",
    "attach.command.json",
    "detach.command.json",
    "success.response.json",
    "message.event.json",
    "event-dropped.event.json",
    "error.response.json",
  ]) {
    const value = await fixture(name);
    assert.equal(validate(value), true, `${name}: ${ajv.errorsText(validate.errors)}`);
  }
});

test("parses handshake open wake and attachment fixtures", async () => {
  assert.equal(parseCommand(await fixture("handshake.command.json")).operation, "handshake");
  const openInput = await fixture("open.command.json");
  openInput.payload.model.thinkingLevel = "max";
  const open = parseCommand(openInput);
  assert.equal(open.operation, "open");
  assert.equal(open.sessionId, "agent-a");
  assert.equal(open.payload.model.thinkingLevel, "max");
  const wake = parseCommand(await fixture("wake.command.json"));
  assert.equal(wake.operation, "wake");
  assert.equal(wake.idempotencyKey, "message-019f");
  assert.equal(parseCommand(await fixture("attach.command.json")).operation, "attach");
  assert.equal(parseCommand(await fixture("detach.command.json")).operation, "detach");
});

test("accepts unknown fields for minor-version forward compatibility", async () => {
  const input = await fixture("wake.command.json");
  input.protocolVersion = "1.99";
  input.futureTopLevel = { enabled: true };
  input.payload.futurePayload = "preserved by caller";
  assert.equal(parseCommand(input).operation, "wake");
});

test("rejects incompatible major and unknown operations", async () => {
  const incompatible = await fixture("handshake.command.json");
  incompatible.protocolVersion = "2.0";
  assert.throws(
    () => parseCommand(incompatible),
    (error) => error instanceof ProtocolValidationError && error.code === "incompatible_protocol",
  );

  const unknown = await fixture("handshake.command.json");
  unknown.operation = "launchMissiles";
  assert.throws(
    () => parseCommand(unknown),
    (error) => error instanceof ProtocolValidationError && error.code === "unknown_operation",
  );
});

test("validates session identities resource policy and prompt bounds", async () => {
  const open = await fixture("open.command.json");
  open.payload.resources.extensions = "project";
  assert.throws(
    () => parseCommand(open),
    (error) =>
      error instanceof ProtocolValidationError && error.code === "unsupported_resource_policy",
  );

  const wake = await fixture("wake.command.json");
  delete wake.idempotencyKey;
  assert.throws(
    () => parseCommand(wake),
    (error) => error instanceof ProtocolValidationError && error.code === "invalid_field",
  );

  const tooLong = await fixture("wake.command.json");
  tooLong.payload.prompt = "12345";
  assert.throws(() => parseCommand(tooLong, { maxPromptChars: 4 }));
});

test("open mode requires a session path", async () => {
  const open = await fixture("open.command.json");
  open.payload.session = { mode: "open" };
  assert.throws(
    () => parseCommand(open),
    (error) => error instanceof ProtocolValidationError && error.code === "invalid_field",
  );
});

test("NDJSON decoder handles fragmentation CRLF and multiple values", () => {
  const decoder = new NdjsonDecoder(1024);
  assert.deepEqual(decoder.push(Buffer.from('{"a":1}\n{"b"')), [{ a: 1 }]);
  assert.deepEqual(decoder.push(Buffer.from(":2}\r\n\n")), [{ b: 2 }]);
  assert.deepEqual(decoder.finish(), []);
});

test("NDJSON decoder rejects malformed UTF-8 JSON and oversized lines", () => {
  assert.throws(
    () => new NdjsonDecoder(32).push(Buffer.from("x".repeat(33))),
    (error) => error instanceof ProtocolValidationError && error.code === "line_too_large",
  );
  assert.throws(
    () => new NdjsonDecoder().push(Buffer.from("not-json\n")),
    (error) => error instanceof ProtocolValidationError && error.code === "invalid_json",
  );
  assert.throws(
    () => new NdjsonDecoder().push(Uint8Array.from([0xff, 0x0a])),
    (error) => error instanceof ProtocolValidationError && error.code === "invalid_utf8",
  );
});

test("bounded encoder preflights size before JSON or Buffer allocation", () => {
  const expected = Buffer.from(`${JSON.stringify({ text: "line\n😀" })}\n`, "utf8");
  assert.deepEqual(encodeBoundedLine({ text: "line\n😀" }, expected.length), expected);

  const originalStringify = JSON.stringify;
  let stringifyCalled = false;
  JSON.stringify = (...args) => {
    stringifyCalled = true;
    return originalStringify(...args);
  };
  let failure;
  try {
    encodeBoundedLine({ text: "x".repeat(8 * 1024 * 1024) }, 1024);
  } catch (error) {
    failure = error;
  } finally {
    JSON.stringify = originalStringify;
  }
  assert.equal(stringifyCalled, false, "oversized data must fail before JSON.stringify");
  assert.ok(failure instanceof ProtocolSerializationError);
  assert.equal(failure.code, "outbound_record_too_large");
});

test("bounded encoder rejects non-plain and non-serializable SDK data", () => {
  const circular = {};
  circular.self = circular;
  const accessor = {};
  Object.defineProperty(accessor, "value", { enumerable: true, get: () => "private" });
  let toJsonCalled = false;
  const custom = {
    toJSON() {
      toJsonCalled = true;
      return { private: "x".repeat(1024 * 1024) };
    },
  };
  for (const value of [{ value: 1n }, circular, accessor, { date: new Date() }, custom]) {
    assert.throws(
      () => encodeBoundedLine(value, 1024),
      (error) =>
        error instanceof ProtocolSerializationError && error.code === "outbound_not_serializable",
    );
  }
  assert.equal(toJsonCalled, false, "custom toJSON must not execute during bounded encoding");
});

test("response and event builders omit absent optional fields", () => {
  const success = successResponse("req-1", "host-1", { ready: true });
  assert.deepEqual(success, {
    protocolVersion: PROTOCOL_VERSION,
    kind: "response",
    requestId: "req-1",
    hostInstanceId: "host-1",
    ok: true,
    data: { ready: true },
  });

  const failure = errorResponse("req-2", "host-1", {
    code: "busy",
    message: "at capacity",
    retryable: true,
  });
  assert.equal(failure.ok, false);
  assert.equal(failure.error?.code, "busy");

  const event = eventEnvelope({
    event: "agentStart",
    hostInstanceId: "host-1",
    sessionId: "agent-a",
    generation: 2,
    sequence: 3,
  });
  assert.equal("requestId" in event, false);
  assert.equal("data" in event, false);
  assert.equal(encodeLine(event).endsWith("\n"), true);
});
