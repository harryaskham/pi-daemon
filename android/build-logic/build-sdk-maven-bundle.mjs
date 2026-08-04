#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const androidRoot = resolve(scriptDirectory, "..");
const propertiesPath = join(androidRoot, "sdk-publication.properties");

function parseProperties(value) {
  return Object.fromEntries(
    value
      .split(/\r?\n/u)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator <= 0) throw new Error("invalid SDK publication properties");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function filesBelow(root) {
  const output = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) output.push(path);
      else throw new Error(`unsupported repository entry: ${path}`);
    }
  }
  visit(root);
  return output;
}

function parseArguments(arguments_) {
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error("expected --repository and --source-revision");
    values[name.slice(2)] = value;
  }
  if (!values.repository || !values["source-revision"]) {
    throw new Error("--repository and --source-revision are required");
  }
  if (!/^[0-9a-f]{7,64}$/u.test(values["source-revision"])) throw new Error("source revision must be a Git object ID");
  return values;
}

export function buildSdkMavenMetadata({ repository, sourceRevision }) {
  const publication = parseProperties(readFileSync(propertiesPath, "utf8"));
  const group = publication.group;
  const version = publication.version;
  const artifacts = publication.artifacts.split(",");
  const groupRoot = join(repository, ...group.split("."));
  if (!statSync(groupRoot).isDirectory()) throw new Error("published SDK group directory is missing");

  const publishedArtifacts = readdirSync(groupRoot).sort();
  if (publishedArtifacts.join(",") !== [...artifacts].sort().join(",")) {
    throw new Error("published SDK artifacts do not match the reviewed release set");
  }

  const artifactRecords = [];
  for (const artifact of artifacts) {
    const artifactRoot = join(groupRoot, artifact);
    for (const file of readdirSync(artifactRoot).filter((name) => name.startsWith("maven-metadata.xml"))) {
      rmSync(join(artifactRoot, file), { force: true });
    }
    if (readdirSync(artifactRoot).join(",") !== version) {
      throw new Error(`${artifact}: repository must contain exactly the reviewed version`);
    }
    const directory = join(artifactRoot, version);
    const prefix = `${artifact}-${version}`;
    const required = [`${prefix}.aar`, `${prefix}-sources.jar`, `${prefix}.pom`, `${prefix}.module`];
    const hashes = {};
    for (const file of required) {
      const path = join(directory, file);
      if (!existsSync(path)) throw new Error(`${artifact}: required publication file missing: ${file}`);
      hashes[file] = sha256(path);
      writeFileSync(`${path}.sha256`, `${hashes[file]}  ${file}\n`);
    }
    const apiBaseline = join(androidRoot, "sdk-api", `${artifact}.api.txt`);
    if (!existsSync(apiBaseline)) throw new Error(`${artifact}: committed API baseline is missing`);
    artifactRecords.push({
      artifact,
      coordinate: `pkg:maven/${group}/${artifact}@${version}`,
      hashes,
      apiBaselineSha256: sha256(apiBaseline),
    });
  }

  const metadata = join(repository, "metadata");
  rmSync(metadata, { recursive: true, force: true });
  const apiMetadata = join(metadata, "api");
  mkdirSync(apiMetadata, { recursive: true });
  for (const record of artifactRecords) {
    const file = `${record.artifact}.api.txt`;
    writeFileSync(join(apiMetadata, file), readFileSync(join(androidRoot, "sdk-api", file)));
    writeFileSync(join(apiMetadata, `${file}.sha256`), `${record.apiBaselineSha256}  ${file}\n`);
  }
  const provenance = {
    schemaVersion: 1,
    group,
    version,
    artifacts,
    sourceRevision,
    credentialsRequired: false,
    publication: "deterministic-local-maven-repository",
    javadocs: "omitted-in-alpha-sources-jar-is-authoritative",
    records: artifactRecords,
  };
  writeFileSync(join(metadata, "provenance.json"), stableJson(provenance));

  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:00000000-0000-5000-8000-${sourceRevision.slice(0, 12).padEnd(12, "0")}`,
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: "pi-droid-sdk-maven-bundle",
        version,
      },
    },
    components: artifactRecords.map((record) => ({
      type: "library",
      group,
      name: record.artifact,
      version,
      purl: record.coordinate,
      hashes: [{ alg: "SHA-256", content: record.hashes[`${record.artifact}-${version}.aar`] }],
      properties: [{ name: "pi-droid:api-baseline-sha256", value: record.apiBaselineSha256 }],
    })),
  };
  writeFileSync(join(metadata, "bom.cdx.json"), stableJson(bom));

  const checksumInputs = [
    ...filesBelow(groupRoot),
    ...filesBelow(metadata).filter((path) => !path.endsWith("SHA256SUMS")),
  ].sort((left, right) => relative(repository, left).localeCompare(relative(repository, right)));
  const checksumLines = checksumInputs.map((path) => `${sha256(path)}  ${relative(repository, path).replaceAll("\\", "/")}`);
  writeFileSync(join(metadata, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);
  return provenance;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = parseArguments(process.argv.slice(2));
  const repository = resolve(arguments_.repository);
  const provenance = buildSdkMavenMetadata({ repository, sourceRevision: arguments_["source-revision"] });
  process.stdout.write(`Pi Droid SDK Maven metadata: ${provenance.group}:${provenance.version} artifacts=${provenance.artifacts.join(",")}\n`);
}
