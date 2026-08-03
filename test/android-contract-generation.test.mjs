import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const generatorPath = path.join(
  rootDir,
  "android/build-logic/generate-protocol-models.mjs",
);
const generatedPath = path.join(
  rootDir,
  "android/sdk-core/src/generated/kotlin/com/harryaskham/pidroid/protocol/generated/GeneratedProtocolContracts.kt",
);

const expectedContractFiles = [
  "dashboard-api.openapi.json",
  "dashboard-api.schema.json",
  "dashboard-session-draft.schema.json",
  "extension-view.schema.json",
  "protocol-v2.schema.json",
  "protocol.schema.json",
  "schedule.schema.json",
  "session-api.openapi.json",
  "session-api.schema.json",
  "tool-adapter.schema.json",
];

async function loadGenerator() {
  return import(pathToFileURL(generatorPath).href);
}

test("Android protocol generation is deterministic and committed", async () => {
  const { CONTRACT_FILES, generateProtocolContracts } = await loadGenerator();
  assert.deepEqual(CONTRACT_FILES, expectedContractFiles);

  const first = await generateProtocolContracts({ rootDir });
  const second = await generateProtocolContracts({ rootDir });
  assert.equal(first.source, second.source);
  assert.deepEqual(first.inputs, second.inputs);
  assert.ok(first.inputs.fixtures.length > 50);
  assert.ok(first.source.endsWith("\n"));
  assert.match(first.source, /enum class PiRpcCommandType/);

  const committed = await readFile(generatedPath, "utf8");
  assert.equal(committed, first.source);
});

test("generated object metadata preserves additive fixture fields", async () => {
  const { loadSchemaDefinition, partitionKnownFields } = await loadGenerator();
  const definition = await loadSchemaDefinition({
    rootDir,
    schemaPath: "protocol-v2.schema.json",
    definitionName: "openCommand",
  });
  assert.deepEqual(
    [...definition.knownFields].sort(),
    [
      "generation",
      "operation",
      "payload",
      "protocolVersion",
      "requestId",
      "sessionId",
    ],
  );

  const fixture = JSON.parse(
    await readFile(
      path.join(rootDir, "fixtures/open-v2-configured-no-tools.command.json"),
      "utf8",
    ),
  );
  const additiveField = {
    nested: ["future", { revision: 2 }],
  };
  const futureFixture = {
    ...fixture,
    futureAndroidField: additiveField,
  };
  const partitioned = partitionKnownFields(
    futureFixture,
    definition.knownFields,
  );

  assert.deepEqual(partitioned.additionalFields, {
    futureAndroidField: additiveField,
  });
  assert.deepEqual(
    { ...partitioned.knownFields, ...partitioned.additionalFields },
    futureFixture,
  );
});
