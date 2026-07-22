import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  EXTENSION_VIEW_CAPABILITY,
  EXTENSION_VIEW_DEFAULT_LIMITS,
  ExtensionViewValidationError,
  createExtensionViewResponse,
  parseExtensionViewDocument,
  parseExtensionViewResponse,
} from "../dist/extension-view-contract.js";
import {
  createExtensionViewFixture,
  createExtensionViewResponseFixture,
} from "../dist/extension-view-fixtures.js";

const json = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

function validationCode(code) {
  return (error) => error instanceof ExtensionViewValidationError && error.code === code;
}

test("versioned extension view fixture validates every bounded primitive without executable browser content", async () => {
  const fixture = createExtensionViewFixture();
  const parsed = parseExtensionViewDocument(fixture);
  assert.deepEqual(parsed, fixture);
  assert.deepEqual(EXTENSION_VIEW_CAPABILITY.limits, EXTENSION_VIEW_DEFAULT_LIMITS);
  assert.equal(EXTENSION_VIEW_CAPABILITY.browserCodeExecution, false);
  assert.deepEqual(EXTENSION_VIEW_CAPABILITY.renderers, {
    rich: "native",
    tui: "fallback",
    rpc: "transport",
  });
  assert.equal(JSON.stringify(parsed).includes("javascript:"), false);
  assert.equal(JSON.stringify(parsed).includes("<script"), false);

  const [schema, frozen] = await Promise.all([
    json("../extension-view.schema.json"),
    json("../fixtures/extension-view/view.valid.json"),
  ]);
  assert.deepEqual(frozen, fixture);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/view`);
  assert.ok(validate);
  assert.equal(validate(frozen), true, ajv.errorsText(validate.errors));
});

test("action responses remain correlated to the exact view revision and capability scope", async () => {
  const view = parseExtensionViewDocument(createExtensionViewFixture());
  const response = createExtensionViewResponse(view, "submit-review", {
    summary: "Looks safe",
    decision: "approve",
    confirmed: true,
    notes: "Proceed with bounded rendering.",
  });
  assert.deepEqual(response, createExtensionViewResponseFixture());
  assert.deepEqual(parseExtensionViewResponse(response, view), response);
  assert.throws(
    () => createExtensionViewResponse(view, "undeclared-action"),
    validationCode("invalid-view"),
  );
  assert.throws(
    () => parseExtensionViewResponse({ ...response, revision: response.revision + 1 }, view),
    validationCode("invalid-view"),
  );
  assert.throws(
    () => createExtensionViewResponse(view, "submit-review", {
      summary: "Looks safe",
      decision: "execute-arbitrary-code",
      confirmed: true,
    }),
    validationCode("invalid-view"),
  );
  assert.throws(
    () => createExtensionViewResponse(view, "continue", { injected: "value" }),
    validationCode("invalid-view"),
  );

  const schema = await json("../extension-view.schema.json");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/response`);
  assert.ok(validate);
  assert.equal(validate(await json("../fixtures/extension-view/response.valid.json")), true, ajv.errorsText(validate.errors));
});

test("validator fails closed on unknown code, ambient links, undeclared actions, depth and aggregate text", () => {
  const base = createExtensionViewFixture();
  assert.throws(
    () => parseExtensionViewDocument({ ...base, executable: "alert(1)" }),
    validationCode("invalid-view"),
  );
  assert.throws(
    () => parseExtensionViewDocument({
      ...base,
      root: { type: "image", blobRef: "javascript:alert(1)", mediaType: "image/png", alt: "bad" },
      capabilities: { ...base.capabilities, actions: [] },
    }),
    validationCode("invalid-view"),
  );
  assert.throws(
    () => parseExtensionViewDocument({
      ...base,
      capabilities: { ...base.capabilities, actions: [] },
    }),
    validationCode("invalid-view"),
  );

  let deep = { type: "text", text: "leaf" };
  for (let index = 0; index < EXTENSION_VIEW_DEFAULT_LIMITS.maxDepth; index += 1) {
    deep = { type: "stack", children: [deep] };
  }
  assert.throws(
    () => parseExtensionViewDocument({
      ...base,
      capabilities: { ...base.capabilities, actions: [] },
      root: deep,
    }),
    validationCode("view-capacity"),
  );
  assert.throws(
    () => parseExtensionViewDocument({
      ...base,
      capabilities: { ...base.capabilities, actions: [] },
      root: { type: "text", text: "x".repeat(EXTENSION_VIEW_DEFAULT_LIMITS.maxTextBytes + 1) },
    }, { maxViewBytes: EXTENSION_VIEW_DEFAULT_LIMITS.maxTextBytes * 2 }),
    validationCode("view-capacity"),
  );
});
