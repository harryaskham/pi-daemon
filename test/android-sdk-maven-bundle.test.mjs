import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const android = join(root, "android");
const group = "com.harryaskham.pidroid.sdk";
const version = "0.3.0-alpha.2";
const apiBaselineRevision = "session-lifecycle-host-registry-v1";
const artifacts = ["core", "session-ui", "workspace-ui"];
const expectedSources = {
  core: "com/harryaskham/pidroid/sdk/core/Transport.kt",
  "session-ui": "com/harryaskham/pidroid/sessionui/SessionSurface.kt",
  "workspace-ui": "com/harryaskham/pidroid/workspace/WorkspaceComposeShell.kt",
};

function read(path) {
  return readFileSync(path, "utf8");
}

function artifactDirectory(repository, artifact) {
  return join(repository, ...group.split("."), artifact, version);
}

function assertPublishedArtifact(repository, artifact) {
  const directory = artifactDirectory(repository, artifact);
  assert.ok(statSync(directory).isDirectory(), `${artifact}: version directory missing`);
  const prefix = `${artifact}-${version}`;
  const required = [
    `${prefix}.aar`,
    `${prefix}-sources.jar`,
    `${prefix}.pom`,
    `${prefix}.module`,
  ];
  const files = readdirSync(directory).sort();
  for (const file of required) {
    assert.ok(files.includes(file), `${artifact}: ${file} missing`);
    assert.ok(files.includes(`${file}.sha256`), `${artifact}: ${file}.sha256 missing`);
  }
  assert.equal(files.some((file) => /javadoc/i.test(file)), false, `${artifact}: alpha policy forbids javadocs artifact`);

  const pom = read(join(directory, `${prefix}.pom`));
  assert.match(pom, new RegExp(`<groupId>${group}</groupId>`));
  assert.match(pom, new RegExp(`<artifactId>${artifact}</artifactId>`));
  assert.match(pom, new RegExp(`<version>${version.replaceAll(".", "\\.")}</version>`));
  assert.doesNotMatch(pom, /SNAPSHOT|\[|\]|LATEST|RELEASE|mavenLocal|bearer|token|credential/i);
  if (artifact === "session-ui") {
    assert.match(
      pom,
      new RegExp(
        `<groupId>${group.replaceAll(".", "\\.")}</groupId>\\s*<artifactId>core</artifactId>\\s*<version>${version.replaceAll(".", "\\.")}</version>`,
        "u",
      ),
    );
    assert.doesNotMatch(pom, /sdk-core-android/);
  }

  const module = read(join(directory, `${prefix}.module`));
  assert.doesNotMatch(module, /SNAPSHOT|mavenLocal|bearer|token|credential/i);
  assert.doesNotMatch(module, /org\.jetbrains\.compose\.desktop|skiko-awt|currentOs/i);

  const sources =
    execFileSync("jar", ["--list", "--file", join(directory, `${prefix}-sources.jar`)], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  assert.ok(sources.includes(expectedSources[artifact]), `${artifact}: canonical source missing`);
  assert.equal(sources.some((entry) => /WorkspaceFixtureApp|\.so$|skiko|desktop/i.test(entry)), false);
}

test("Pi Droid SDK publication source contract is explicit and credential free", () => {
  const versionFile = join(android, "sdk-publication.properties");
  const bundleScript = join(android, "build-logic", "build-sdk-maven-bundle.mjs");
  const nixFunction = join(root, "nix", "pi-droid-sdk-maven-archive.nix");
  const migrations = join(android, "SDK-MIGRATIONS.md");

  for (const path of [versionFile, bundleScript, nixFunction, migrations]) {
    assert.ok(existsSync(path), `${basename(path)} missing`);
  }
  const properties = read(versionFile);
  assert.match(properties, /^group=com\.harryaskham\.pidroid\.sdk$/m);
  assert.match(properties, /^version=0\.3\.0-alpha\.2$/m);
  assert.match(properties, /^artifacts=core,session-ui,workspace-ui$/m);
  assert.match(properties, /^apiBaselineRevision=session-lifecycle-host-registry-v1$/m);
  assert.match(properties, /^previouslyPublished=false$/m);

  const coreBaseline = read(join(android, "sdk-api", "core.api.txt"));
  assert.match(coreBaseline, /withBearerSuspending/);
  assert.match(coreBaseline, /NeutralHttpRequest http\([^\n]+java\.util\.List<kotlin\.Pair/);
  assert.match(coreBaseline, /SessionLifecycleCoordinator/);
  assert.match(coreBaseline, /createConfiguredSession/);
  const migrationText = read(migrations);
  assert.match(migrationText, /session-lifecycle-host-registry-v1/);
  assert.match(migrationText, /live-readonly-v2/);
  assert.match(migrationText, /HostCredentialVault\.withBearerSuspending/);
  assert.match(migrationText, /ServiceBearerRequestFactory\.http/);

  const settings = read(join(android, "settings.gradle.kts"));
  assert.match(settings, /piDroidAndroidSdk/);
  assert.match(settings, /piDroidAndroidApp \|\| piDroidAndroidSdk/);

  const rootBuild = read(join(android, "build.gradle.kts"));
  assert.match(rootBuild, /sdk-publication\.properties/);
  assert.match(rootBuild, /maven-publish/);
  assert.match(rootBuild, /withSourcesJar\(\)/);
  assert.match(rootBuild, /isPreserveFileTimestamps\s*=\s*false/);
  assert.match(rootBuild, /isReproducibleFileOrder\s*=\s*true/);
  assert.doesNotMatch(rootBuild, /mavenLocal\(\)|credentials\s*\{|System\.getenv|SNAPSHOT|LATEST|RELEASE/);

  const script = read(bundleScript);
  assert.match(script, /cyclonedx/i);
  assert.match(script, /provenance/i);
  assert.match(script, /SHA256SUMS/);
  assert.doesNotMatch(script, /curl|fetch\(|https?:\/\/|process\.env|authorization|github_token|npm_config/i);

  const nixSource = read(nixFunction);
  assert.match(nixSource, /--sort=name/);
  assert.match(nixSource, /--mtime='@1'/);
  assert.match(nixSource, /--owner=0/);
  assert.match(nixSource, /--group=0/);
  assert.match(nixSource, /gzip -n -9/);
  assert.doesNotMatch(nixSource, /fetchurl|fetchzip|https?:\/\//i);

  const flake = read(join(root, "flake.nix"));
  assert.match(flake, /lib\.piDroidSdkMavenArchive/);

  const sample = join(android, "sdk-consumer-sample");
  const sampleSettings = read(join(sample, "settings.gradle.kts"));
  const sampleBuild = read(join(sample, "consumer", "build.gradle.kts"));
  const sampleSource = read(
    join(sample, "consumer", "src", "main", "kotlin", "com", "harryaskham", "pidroid", "sdk", "consumer", "sample", "InjectedSdkConsumer.kt"),
  );
  assert.match(sampleSettings, /piDroidSdkRepositoryDir/);
  assert.doesNotMatch(sampleSettings, /mavenLocal\(\)|credentials\s*\{|https?:\/\//i);
  for (const artifact of artifacts) {
    assert.match(sampleBuild, new RegExp(`com\\.harryaskham\\.pidroid\\.sdk:${artifact}:${version.replaceAll(".", "\\.")}`));
  }
  assert.match(sampleSource, /PiDaemonTransport/);
  assert.match(sampleSource, /SessionSurface/);
  assert.match(sampleSource, /PiDroidWorkspaceShell/);
  assert.doesNotMatch(sampleSource, /getBearer|sharedUserId|localhost|cacophony/i);
});

test("materialized local Maven repository has exact immutable artifacts and metadata", (context) => {
  const repository = process.env.PI_DROID_SDK_MAVEN_REPOSITORY;
  if (!repository) {
    context.skip("set PI_DROID_SDK_MAVEN_REPOSITORY to inspect a materialized repository");
    return;
  }
  for (const artifact of artifacts) assertPublishedArtifact(repository, artifact);

  const metadata = join(repository, "metadata");
  for (const file of ["provenance.json", "bom.cdx.json", "SHA256SUMS"]) {
    assert.ok(existsSync(join(metadata, file)), `metadata/${file} missing`);
  }
  for (const artifact of artifacts) {
    assert.ok(existsSync(join(metadata, "api", `${artifact}.api.txt`)), `metadata/api/${artifact}.api.txt missing`);
    assert.ok(existsSync(join(metadata, "api", `${artifact}.api.txt.sha256`)), `metadata API checksum missing for ${artifact}`);
  }
  const provenance = JSON.parse(read(join(metadata, "provenance.json")));
  assert.equal(provenance.group, group);
  assert.equal(provenance.version, version);
  assert.deepEqual(provenance.artifacts, artifacts);
  assert.equal(provenance.credentialsRequired, false);
  assert.equal(provenance.apiBaselineRevision, apiBaselineRevision);
  assert.equal(provenance.previouslyPublished, false);
  assert.equal(provenance.records.length, artifacts.length);
  assert.ok(provenance.records.every((record) => /^[0-9a-f]{64}$/u.test(record.apiBaselineSha256)));

  const bom = JSON.parse(read(join(metadata, "bom.cdx.json")));
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(bom.specVersion, "1.6");
  assert.equal(bom.components.length, artifacts.length);
});
