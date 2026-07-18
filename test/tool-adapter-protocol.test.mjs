import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  ProtocolValidationError,
  errorResponse,
  eventEnvelope,
  parseCommand,
  successResponse,
} from "../dist/protocol.js";
import {
  parseProtocolV2Command,
  parseSupportedProtocolCommand,
} from "../dist/protocol-v2.js";
import {
  HOST_TOOL_ADAPTER_FRAME_KINDS,
  NEUTRAL_TOOL_OPERATIONS,
  parseHostToolAdapterMessage,
  validateHostToolAdapterDescriptor,
  validateToolAdapterRelativePath,
} from "../dist/tool-adapter-protocol.js";

const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

const v2Open = async () => fixture("open-v2-host-tool-adapter.command.json");

const descriptorFrom = (command) => command.payload.resources.tools.descriptor;

const throwsCode = (code) => (error) =>
  error instanceof ProtocolValidationError && error.code === code;

test("v2 and tool-adapter language-neutral fixtures validate against public schemas", async () => {
  const [adapterSchema, v2Schema] = await Promise.all([
    fixture("../tool-adapter.schema.json"),
    fixture("../protocol-v2.schema.json"),
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(adapterSchema);
  const validateAdapter = ajv.getSchema(adapterSchema.$id);
  assert.ok(validateAdapter);
  const validateV2 = ajv.compile(v2Schema);

  const open = await v2Open();
  assert.equal(validateV2(open), true, ajv.errorsText(validateV2.errors));
  assert.equal(
    validateAdapter(descriptorFrom(open)),
    true,
    ajv.errorsText(validateAdapter.errors),
  );
  for (const kind of HOST_TOOL_ADAPTER_FRAME_KINDS) {
    const frame = await fixture(`tool-adapter/${kind}.json`);
    assert.equal(validateAdapter(frame), true, `${kind}: ${ajv.errorsText(validateAdapter.errors)}`);
  }
});

test("v2 accepts a closed generation- and host-bound descriptor while v1 remains no-tools", async () => {
  const input = await v2Open();
  const parsed = parseProtocolV2Command(input, { expectedHostInstanceId: "host-019f" });
  assert.equal(parsed.operation, "open");
  assert.equal(parsed.protocolVersion, "2.0");
  assert.deepEqual(
    parsed.payload.resources.tools.descriptor.operations,
    NEUTRAL_TOOL_OPERATIONS,
  );
  assert.equal(parseSupportedProtocolCommand(input).protocolVersion, "2.0");

  const legacy = await fixture("open.command.json");
  assert.equal(parseSupportedProtocolCommand(legacy).protocolVersion, PROTOCOL_VERSION);
  legacy.payload.resources.tools = "host-adapter";
  assert.throws(() => parseCommand(legacy), throwsCode("unsupported_resource_policy"));
});

test("v2 descriptor rejects endpoint, capability, operation, limits, version and binding drift", async () => {
  const base = await v2Open();
  const cases = [
    ["invalid_tool_adapter_endpoint", (value) => { descriptorFrom(value).endpoint.path = "relative.sock"; }],
    ["invalid_tool_adapter_capability", (value) => { descriptorFrom(value).binding.capabilityHandle = "too-short"; }],
    ["unsupported_tool_operation", (value) => { descriptorFrom(value).operations = ["shell.exec"]; }],
    ["invalid_tool_adapter_limit", (value) => { descriptorFrom(value).limits.maxConcurrentRequests = 0; }],
    ["unsupported_tool_adapter_version", (value) => { descriptorFrom(value).protocolVersion = "9.0"; }],
    ["tool_adapter_binding_mismatch", (value) => { descriptorFrom(value).binding.sessionId = "other"; }],
    ["tool_adapter_binding_mismatch", (value) => { descriptorFrom(value).binding.generation = 3; }],
  ];
  for (const [code, mutate] of cases) {
    const value = structuredClone(base);
    mutate(value);
    assert.throws(
      () => parseProtocolV2Command(value, { expectedHostInstanceId: "host-019f" }),
      throwsCode(code),
      code,
    );
  }
  const staleHost = structuredClone(base);
  assert.throws(
    () => parseProtocolV2Command(staleHost, { expectedHostInstanceId: "host-new" }),
    throwsCode("tool_adapter_binding_mismatch"),
  );
});

test("descriptor limits must contain their own mandatory bind and bound frames", async () => {
  const descriptor = descriptorFrom(await v2Open());
  descriptor.adapterId = "a".repeat(128);
  descriptor.adapterVersion = `1.0.0+${"a".repeat(58)}`;
  descriptor.binding.hostInstanceId = "h".repeat(128);
  descriptor.binding.sessionId = "s".repeat(256);
  descriptor.binding.capabilityHandle = "c".repeat(512);
  descriptor.limits.maxRequestBytes = 1024;
  descriptor.limits.maxResponseBytes = 4194304;
  assert.throws(
    () => validateHostToolAdapterDescriptor(descriptor),
    throwsCode("invalid_tool_adapter_limit"),
  );

  descriptor.limits.maxRequestBytes = 4194304;
  descriptor.limits.maxResponseBytes = 1024;
  assert.equal(validateHostToolAdapterDescriptor(descriptor).limits.maxResponseBytes, 1024);
});

test("descriptor validator closes nested authority fields and never echoes capability values", async () => {
  const descriptor = descriptorFrom(await v2Open());
  const secret = descriptor.binding.capabilityHandle;
  for (const mutate of [
    (value) => { value.bearer = secret; },
    (value) => { value.endpoint.token = secret; },
    (value) => { value.binding.env = { TOKEN: secret }; },
    (value) => { value.limits.unbounded = true; },
  ]) {
    const value = structuredClone(descriptor);
    mutate(value);
    let failure;
    try {
      validateHostToolAdapterDescriptor(value);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof ProtocolValidationError);
    assert.equal(`${failure.message}${JSON.stringify(failure.details)}`.includes(secret), false);
  }
});

test("bind/bound/invoke/result/revoke/abort frames validate identity and keep capability bind-only", async () => {
  const descriptor = descriptorFrom(await v2Open());
  for (const kind of HOST_TOOL_ADAPTER_FRAME_KINDS) {
    const frame = await fixture(`tool-adapter/${kind}.json`);
    const parsed = parseHostToolAdapterMessage(frame, descriptor);
    assert.equal(parsed.kind, kind);
    assert.equal("capabilityHandle" in parsed, kind === "bind");
  }

  const wrongIdentity = await fixture("tool-adapter/result.json");
  wrongIdentity.generation = 3;
  assert.throws(
    () => parseHostToolAdapterMessage(wrongIdentity, descriptor),
    throwsCode("tool_adapter_binding_mismatch"),
  );
  const leakedCapability = await fixture("tool-adapter/result.json");
  leakedCapability.capabilityHandle = descriptor.binding.capabilityHandle;
  assert.throws(
    () => parseHostToolAdapterMessage(leakedCapability, descriptor),
    throwsCode("invalid_tool_adapter_message"),
  );
});

test("tool paths are canonical root-relative POSIX paths", () => {
  assert.equal(validateToolAdapterRelativePath("."), ".");
  assert.equal(validateToolAdapterRelativePath("src/protocol.ts"), "src/protocol.ts");
  for (const path of ["", "/etc/passwd", "../secret", "src/../secret", "src//file", "src\\file", "x\0y"]) {
    assert.throws(() => validateToolAdapterRelativePath(path), throwsCode("invalid_tool_adapter_path"));
  }
});

test("response and event helpers opt into exact v2 echo without changing v1 defaults", () => {
  assert.deepEqual(SUPPORTED_PROTOCOL_VERSIONS, ["1.0", "2.0"]);
  assert.equal(successResponse("r1", "h1", {}).protocolVersion, "1.0");
  assert.equal(errorResponse("r2", "h1", { code: "x", message: "x", retryable: false }).protocolVersion, "1.0");
  assert.equal(
    successResponse("r3", "h1", {}, { protocolVersion: "2.7" }).protocolVersion,
    "2.7",
  );
  assert.equal(
    errorResponse(
      "r4",
      "h1",
      { code: "x", message: "x", retryable: false },
      { protocolVersion: "2.7" },
    ).protocolVersion,
    "2.7",
  );
  assert.equal(
    eventEnvelope({
      protocolVersion: "2.7",
      event: "sessionIdle",
      hostInstanceId: "h1",
      sessionId: "s1",
      generation: 1,
      sequence: 1,
    }).protocolVersion,
    "2.7",
  );
});
