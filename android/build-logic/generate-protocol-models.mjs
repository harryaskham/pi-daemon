#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACT_FILES = Object.freeze([
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
]);

const GENERATED_RELATIVE_PATH =
  "android/sdk-core/src/generated/kotlin/com/harryaskham/pidroid/protocol/generated/GeneratedProtocolContracts.kt";
const GENERATOR_VERSION = 1;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function listJsonFiles(directory, rootDir) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonFiles(absolute, rootDir)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(path.relative(rootDir, absolute).split(path.sep).join("/"));
    }
  }
  return files;
}

const EXPLICIT_SCHEMA_DIAGNOSTIC_KEYWORDS = new Set([
  "contains",
  "dependentSchemas",
  "else",
  "if",
  "not",
  "patternProperties",
  "prefixItems",
  "then",
  "unevaluatedProperties",
]);

async function loadContractRegistry(rootDir) {
  const byPath = new Map();
  const byId = new Map();
  for (const contractPath of CONTRACT_FILES) {
    const bytes = await readFile(path.join(rootDir, contractPath));
    const document = JSON.parse(bytes.toString("utf8"));
    const record = { path: contractPath, bytes, document };
    byPath.set(contractPath, record);
    if (typeof document.$id === "string") {
      byId.set(document.$id, record);
    }
  }
  return { byPath, byId };
}

function resolveReference(registry, currentPath, reference) {
  if (typeof reference !== "string") {
    throw new Error(`${currentPath}: schema reference must be a string`);
  }
  const hashIndex = reference.indexOf("#");
  const documentReference = hashIndex === -1 ? reference : reference.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : reference.slice(hashIndex + 1);
  if (!fragment.startsWith("/$defs/") || fragment.slice(8).includes("/")) {
    throw new Error(`${currentPath}: unsupported schema reference fragment ${reference}`);
  }

  let target;
  if (documentReference.length === 0) {
    target = registry.byPath.get(currentPath);
  } else if (/^https?:\/\//.test(documentReference)) {
    target = registry.byId.get(documentReference);
  } else {
    const relativePath = path.posix.normalize(
      path.posix.join(path.posix.dirname(currentPath), documentReference),
    );
    target = registry.byPath.get(relativePath);
  }
  if (target === undefined) {
    throw new Error(`${currentPath}: unresolved schema document ${reference}`);
  }
  const definitionName = decodeURIComponent(fragment.slice("/$defs/".length));
  const definition = target.document.$defs?.[definitionName];
  if (definition === undefined) {
    throw new Error(`${currentPath}: unresolved schema definition ${reference}`);
  }
  return {
    schemaPath: target.path,
    definitionName,
    definition,
  };
}

function collectSchemaDiagnostics(node, location, diagnostics) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((member, index) =>
      collectSchemaDiagnostics(member, `${location}/${index}`, diagnostics),
    );
    return;
  }
  for (const [keyword, value] of Object.entries(node)) {
    if (EXPLICIT_SCHEMA_DIAGNOSTIC_KEYWORDS.has(keyword)) {
      diagnostics.add(
        `${location}: ${keyword} remains authoritative in JSON Schema and is not flattened into generated object metadata`,
      );
    }
    collectSchemaDiagnostics(value, `${location}/${keyword}`, diagnostics);
  }
}

function collectObjectShape(
  registry,
  currentPath,
  node,
  seenReferences,
  result,
) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return;
  }
  if (node.$ref !== undefined) {
    const resolved = resolveReference(registry, currentPath, node.$ref);
    const identity = `${resolved.schemaPath}#/$defs/${resolved.definitionName}`;
    if (!seenReferences.has(identity)) {
      seenReferences.add(identity);
      collectObjectShape(
        registry,
        resolved.schemaPath,
        resolved.definition,
        seenReferences,
        result,
      );
      seenReferences.delete(identity);
    }
  }
  for (const member of node.allOf ?? []) {
    collectObjectShape(registry, currentPath, member, seenReferences, result);
  }
  for (const name of node.required ?? []) {
    if (typeof name === "string") {
      result.requiredFields.add(name);
    }
  }
  for (const [name, property] of Object.entries(node.properties ?? {})) {
    result.knownFields.set(name, property);
  }
}

function schemaKind(node) {
  if (Array.isArray(node?.enum)) return "ENUM";
  if (node?.const !== undefined) return "CONST";
  if (Array.isArray(node?.oneOf) || Array.isArray(node?.anyOf)) return "UNION";
  if (Array.isArray(node?.allOf)) return "OBJECT";
  if (typeof node?.$ref === "string") return "REFERENCE";
  switch (node?.type) {
    case "object":
      return "OBJECT";
    case "array":
      return "ARRAY";
    case "string":
      return "STRING";
    case "integer":
      return "INTEGER";
    case "number":
      return "NUMBER";
    case "boolean":
      return "BOOLEAN";
    case "null":
      return "NULL";
    default:
      return "ANY";
  }
}

function enumValues(node) {
  const values = [];
  if (Array.isArray(node?.enum)) {
    values.push(...node.enum.filter((value) => typeof value === "string"));
  }
  if (typeof node?.const === "string") {
    values.push(node.const);
  }
  return [...new Set(values)].sort();
}

function describeSchemaDefinition({
  registry,
  schemaPath,
  definitionName,
}) {
  const schema = registry.byPath.get(schemaPath)?.document;
  const definition = schema?.$defs?.[definitionName];
  if (definition === undefined) {
    throw new Error(`${schemaPath} has no $defs/${definitionName}`);
  }
  const shape = {
    knownFields: new Map(),
    requiredFields: new Set(),
  };
  const identity = `${schemaPath}#/$defs/${definitionName}`;
  collectObjectShape(registry, schemaPath, definition, new Set([identity]), shape);
  const diagnostics = new Set();
  collectSchemaDiagnostics(definition, identity, diagnostics);
  return {
    schemaPath,
    definitionName,
    kind: schemaKind(definition),
    knownFields: new Set([...shape.knownFields.keys()].sort()),
    requiredFields: new Set([...shape.requiredFields].sort()),
    enumValues: enumValues(definition),
    diagnostics: [...diagnostics].sort(),
  };
}

export async function loadSchemaDefinition({
  rootDir,
  schemaPath,
  definitionName,
}) {
  const registry = await loadContractRegistry(rootDir);
  return describeSchemaDefinition({ registry, schemaPath, definitionName });
}

export function partitionKnownFields(value, knownFields) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("protocol object must be a non-null JSON object");
  }
  const names = new Set(knownFields);
  const known = {};
  const additional = {};
  for (const [name, fieldValue] of Object.entries(value)) {
    (names.has(name) ? known : additional)[name] = fieldValue;
  }
  return {
    knownFields: known,
    additionalFields: additional,
  };
}

function kotlinString(value) {
  return JSON.stringify(value)
    .replaceAll("$", "\\$")
    .replaceAll("\\u2028", "\\u2028")
    .replaceAll("\\u2029", "\\u2029");
}

function kotlinList(values) {
  if (values.length === 0) return "emptyList()";
  return `listOf(${values.map(kotlinString).join(", ")})`;
}

function kotlinSet(values) {
  if (values.length === 0) return "emptySet()";
  return `setOf(${values.map(kotlinString).join(", ")})`;
}

function enumIdentifier(wireValue, used) {
  let identifier = wireValue
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  if (identifier.length === 0 || /^[0-9]/.test(identifier)) {
    identifier = `VALUE_${identifier}`;
  }
  let unique = identifier;
  let suffix = 2;
  while (used.has(unique)) {
    unique = `${identifier}_${suffix}`;
    suffix += 1;
  }
  used.add(unique);
  return unique;
}

function renderSource({ contracts, fixtures, definitions, commandTypes }) {
  const usedCommandIdentifiers = new Set();
  const commandEntries = commandTypes.map(
    (wireValue) =>
      `  ${enumIdentifier(wireValue, usedCommandIdentifiers)}(${kotlinString(wireValue)})`,
  );
  const definitionEntries = definitions.map(
    (definition) => `    SchemaDefinition(
      schemaPath = ${kotlinString(definition.schemaPath)},
      name = ${kotlinString(definition.definitionName)},
      kind = SchemaKind.${definition.kind},
      knownFields = ${kotlinSet([...definition.knownFields])},
      requiredFields = ${kotlinSet([...definition.requiredFields])},
      enumValues = ${kotlinList(definition.enumValues)},
      diagnostics = ${kotlinList(definition.diagnostics)},
    )`,
  );
  const inputEntries = [...contracts, ...fixtures].map(
    (input) => `    ProtocolInput(
      path = ${kotlinString(input.path)},
      sha256 = ${kotlinString(input.sha256)},
      kind = ProtocolInputKind.${input.kind},
    )`,
  );

  return `// Generated by android/build-logic/generate-protocol-models.mjs.
// Do not edit by hand; run the generator or its --check mode.
package com.harryaskham.pidroid.protocol.generated

import kotlinx.serialization.json.JsonObject

public enum class SchemaKind {
  ANY,
  ARRAY,
  BOOLEAN,
  CONST,
  ENUM,
  INTEGER,
  NULL,
  NUMBER,
  OBJECT,
  REFERENCE,
  STRING,
  UNION,
}

public enum class ProtocolInputKind {
  CONTRACT,
  FIXTURE,
}

public data class ProtocolInput(
  public val path: String,
  public val sha256: String,
  public val kind: ProtocolInputKind,
)

public data class SchemaDefinition(
  public val schemaPath: String,
  public val name: String,
  public val kind: SchemaKind,
  public val knownFields: Set<String>,
  public val requiredFields: Set<String>,
  public val enumValues: List<String>,
  public val diagnostics: List<String>,
)

public data class AdditiveObject(
  public val knownFields: JsonObject,
  public val additionalFields: JsonObject,
) {
  public fun toJsonObject(): JsonObject = JsonObject(knownFields + additionalFields)
}

public enum class PiRpcCommandType(public val wireValue: String) {
${commandEntries.join(",\n")};

  public companion object {
    private val byWireValue = entries.associateBy(PiRpcCommandType::wireValue)

    public fun fromWireValue(value: String): PiRpcCommandType? = byWireValue[value]
  }
}

public object GeneratedProtocolContracts {
  public const val generatorVersion: Int = ${GENERATOR_VERSION}

  public val definitions: List<SchemaDefinition> = listOf(
${definitionEntries.join(",\n")}
  )

  public val inputs: List<ProtocolInput> = listOf(
${inputEntries.join(",\n")}
  )

  public fun definition(schemaPath: String, name: String): SchemaDefinition =
    definitions.single { it.schemaPath == schemaPath && it.name == name }

  public fun partitionKnownFields(
    definition: SchemaDefinition,
    value: JsonObject,
  ): AdditiveObject {
    val (known, additional) = value.entries.partition { (name, _) ->
      name in definition.knownFields
    }
    return AdditiveObject(
      knownFields = JsonObject(known.associate { it.toPair() }),
      additionalFields = JsonObject(additional.associate { it.toPair() }),
    )
  }
}
`;
}

export async function generateProtocolContracts({ rootDir }) {
  const registry = await loadContractRegistry(rootDir);
  const contractInputs = [];
  const definitions = [];
  for (const contractPath of CONTRACT_FILES) {
    const record = registry.byPath.get(contractPath);
    contractInputs.push({
      path: contractPath,
      sha256: sha256(record.bytes),
      kind: "CONTRACT",
    });
    for (const definitionName of Object.keys(record.document.$defs ?? {}).sort()) {
      definitions.push(
        describeSchemaDefinition({
          registry,
          schemaPath: contractPath,
          definitionName,
        }),
      );
    }
  }

  const fixturePaths = await listJsonFiles(path.join(rootDir, "fixtures"), rootDir);
  const fixtureInputs = [];
  for (const fixturePath of fixturePaths) {
    const bytes = await readFile(path.join(rootDir, fixturePath));
    JSON.parse(bytes.toString("utf8"));
    fixtureInputs.push({
      path: fixturePath,
      sha256: sha256(bytes),
      kind: "FIXTURE",
    });
  }

  const commandTypesFixture = JSON.parse(
    await readFile(path.join(rootDir, "fixtures/pi-rpc-command-types.json"), "utf8"),
  );
  const commandTypes = commandTypesFixture.commandTypes;
  if (
    !Array.isArray(commandTypes) ||
    commandTypes.some((value) => typeof value !== "string")
  ) {
    throw new Error("fixtures/pi-rpc-command-types.json has invalid commandTypes");
  }

  return {
    source: renderSource({
      contracts: contractInputs,
      fixtures: fixtureInputs,
      definitions,
      commandTypes,
    }),
    inputs: {
      contracts: contractInputs,
      fixtures: fixtureInputs,
    },
  };
}

async function runCli() {
  const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const outputPath = path.join(rootDir, GENERATED_RELATIVE_PATH);
  const check = process.argv.includes("--check");
  const print = process.argv.includes("--stdout");
  const { source } = await generateProtocolContracts({ rootDir });

  if (print) {
    process.stdout.write(source);
    return;
  }
  if (check) {
    const committed = await readFile(outputPath, "utf8").catch(() => undefined);
    if (committed !== source) {
      throw new Error(
        `${GENERATED_RELATIVE_PATH} is stale; run node android/build-logic/generate-protocol-models.mjs`,
      );
    }
    return;
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, source, "utf8");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await runCli();
}
