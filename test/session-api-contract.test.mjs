import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  CONTROL_MODE_EQUIVALENCE,
  PI_RPC_COMMAND_TYPES,
  SESSION_API_PATHS,
  SESSION_API_VERSION,
  SESSION_RPC_SUBPROTOCOLS,
} from "../dist/session-api.js";

const readJson = async (path) =>
  JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));

const fixture = (name) => readJson(`fixtures/session-api/${name}`);

async function contractValidator() {
  const schema = await readJson("session-api.schema.json");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(schema);
  const validate = (definition, value) => {
    const compiled = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
    assert.ok(compiled, `missing compiled schema definition: ${definition}`);
    assert.equal(
      compiled(value),
      true,
      `${definition}: ${ajv.errorsText(compiled.errors)}`,
    );
  };
  return { schema, ajv, validate };
}

test("session API fixtures validate against their published definitions", async () => {
  const { validate } = await contractValidator();
  for (const [name, definition] of [
    ["create.request.json", "sessionCreateRequest"],
    ["update.request.json", "sessionUpdateRequest"],
    ["session.resource.json", "sessionResource"],
    ["session.response.json", "sessionEnvelope"],
    ["list.response.json", "sessionListEnvelope"],
    ["ticket.response.json", "ticketEnvelope"],
    ["capabilities.response.json", "capabilitiesEnvelope"],
    ["rpc.raw-command.json", "piRpcCommand"],
    ["rpc.raw-event.json", "piRpcEvent"],
    ["rpc.command.frame.json", "rpcCommandFrame"],
    ["rpc.response.frame.json", "rpcResponseFrame"],
    ["rpc.control.frame.json", "rpcControlFrame"],
    ["rpc.ready.frame.json", "rpcAttachReadyFrame"],
    ["rpc.event.frame.json", "rpcEventFrame"],
    ["rpc.replay-gap.frame.json", "rpcReplayGapFrame"],
    ["apc.initialize.json", "jsonRpcMessage"],
    ["error.response.json", "apiErrorEnvelope"],
  ]) {
    validate(definition, await fixture(name));
  }
});

test("session resources cannot disclose raw environment values", async () => {
  const { schema, ajv } = await contractValidator();
  const response = await fixture("session.response.json");
  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes("fixture-redacted-value"), false);
  assert.equal(Object.hasOwn(response.data.spec, "env"), false);

  response.data.spec.env = { PROVIDER_TOKEN: "must-not-escape" };
  const validate = ajv.getSchema(`${schema.$id}#/$defs/sessionEnvelope`);
  assert.ok(validate);
  assert.equal(validate(response), false);
});

test("session target and framed event invariants reject ambiguous records", async () => {
  const { schema, ajv } = await contractValidator();
  const create = await fixture("create.request.json");
  create.spec.target = { mode: "open" };
  const validateCreate = ajv.getSchema(`${schema.$id}#/$defs/sessionCreateRequest`);
  assert.ok(validateCreate);
  assert.equal(validateCreate(create), false);

  const event = await fixture("rpc.event.frame.json");
  event.event.type = "response";
  const validateEvent = ajv.getSchema(`${schema.$id}#/$defs/rpcEventFrame`);
  assert.ok(validateEvent);
  assert.equal(validateEvent(event), false);
});

test("Pi RPC compatibility inventory is exact and includes settled-era commands", async () => {
  const schema = await readJson("session-api.schema.json");
  assert.deepEqual(schema.$defs.piRpcCommand.properties.type.enum, [...PI_RPC_COMMAND_TYPES]);
  assert.equal(PI_RPC_COMMAND_TYPES.length, 31);
  for (const command of ["get_entries", "get_tree", "set_thinking_level", "get_commands"]) {
    assert.equal(PI_RPC_COMMAND_TYPES.includes(command), true);
  }
  assert.deepEqual([...SESSION_RPC_SUBPROTOCOLS], ["pi-rpc.v1", "pi-daemon-rpc.v1"]);
});

test("OpenAPI publishes every route, service bearer auth, and resolvable contract refs", async () => {
  const schema = await readJson("session-api.schema.json");
  const openapi = await readJson("session-api.openapi.json");
  assert.equal(openapi.openapi, "3.1.0");
  assert.equal(openapi.info.version, "1.0.0");
  assert.deepEqual(openapi.security, [{ serviceBearer: [] }]);
  assert.equal(openapi.components.securitySchemes.serviceBearer.scheme, "bearer");

  for (const route of Object.values(SESSION_API_PATHS)) {
    const relative = route.replace(/^\/v1/, "");
    assert.ok(openapi.paths[relative], `missing OpenAPI path: ${relative}`);
  }
  assert.equal(
    openapi.paths["/session/{sessionRef}/apc"].get["x-upstream-protocol"],
    "Agent Client Protocol JSON-RPC 2.0",
  );

  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (typeof value.$ref === "string" && value.$ref.startsWith("./session-api.schema.json#/$defs/")) {
      const definition = value.$ref.slice(value.$ref.lastIndexOf("/") + 1);
      assert.ok(schema.$defs[definition], `unresolved external schema ref: ${value.$ref}`);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(openapi);
});

test("control modes name one logical lifecycle despite transport timing differences", () => {
  assert.equal(SESSION_API_VERSION, "1.0");
  assert.deepEqual(CONTROL_MODE_EQUIVALENCE.create, {
    ndjson: "open",
    rest: "POST /v1/session",
    rpc: "new_session",
  });
  assert.equal(CONTROL_MODE_EQUIVALENCE.prompt.ndjson, "wake");
  assert.equal(CONTROL_MODE_EQUIVALENCE.prompt.rpc, "prompt");
  assert.equal(CONTROL_MODE_EQUIVALENCE.close.rest, "DELETE /v1/session/{sessionRef}");
});
