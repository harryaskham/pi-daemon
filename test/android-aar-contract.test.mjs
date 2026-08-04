import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

import { snapshotSdkApi } from "../android/build-logic/snapshot-sdk-api.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const androidRoot = join(repositoryRoot, "android");

const modules = [
  {
    name: "sdk-core-android",
    source: "../sdk-core/src/main/kotlin",
    expectedClasses: ["com/harryaskham/pidroid/sdk/core/PiDaemonTransport.class"],
    forbiddenClasses: [],
    apiExcludePrefixes: [],
  },
  {
    name: "sdk-session-ui-android",
    source: "../sdk-session-ui/src/main/kotlin",
    expectedClasses: [
      "com/harryaskham/pidroid/sessionui/SessionSurfaceKt.class",
      "com/harryaskham/pidroid/sessionui/InteractiveSessionSurfacesKt.class",
      "com/harryaskham/pidroid/sessionui/TuiSurfaceKt.class",
    ],
    forbiddenClasses: [],
    apiExcludePrefixes: [],
  },
  {
    name: "sdk-workspace-ui-android",
    source: "../sdk-workspace-ui/src/main/kotlin",
    expectedClasses: ["com/harryaskham/pidroid/workspace/WorkspaceComposeShellKt.class"],
    forbiddenClasses: ["com/harryaskham/pidroid/workspace/WorkspaceFixtureAppKt.class"],
    apiExcludePrefixes: [
      "com.harryaskham.pidroid.workspace.WorkspaceFixtureAppKt",
      "com.harryaskham.pidroid.workspace.ComposableSingletons$WorkspaceFixtureAppKt",
    ],
  },
];

function text(path) {
  return readFileSync(path, "utf8");
}

function jarEntries(path) {
  return execFileSync("jar", ["--list", "--file", path], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

function aarEntries(path) {
  return execFileSync("unzip", ["-Z1", path], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

function inspectAar(module, aarPath) {
  const entries = aarEntries(aarPath);
  assert.ok(entries.includes("AndroidManifest.xml"), `${module.name}: manifest missing`);
  assert.ok(entries.includes("classes.jar"), `${module.name}: classes.jar missing`);
  assert.ok(entries.includes("proguard.txt"), `${module.name}: consumer rules missing`);
  assert.equal(entries.some((entry) => entry.startsWith("jni/")), false, `${module.name}: native payload forbidden`);
  assert.equal(entries.some((entry) => /skiko|desktop/i.test(entry)), false, `${module.name}: desktop payload forbidden`);

  const temporary = mkdtempSync(join(tmpdir(), "pi-droid-aar-"));
  try {
    const classesJar = join(temporary, "classes.jar");
    const bytes = execFileSync("unzip", ["-p", aarPath, "classes.jar"]);
    writeFileSync(classesJar, bytes);
    const classes = jarEntries(classesJar);
    for (const expected of module.expectedClasses) {
      assert.ok(classes.includes(expected), `${module.name}: expected API class missing: ${expected}`);
    }
    for (const forbidden of module.forbiddenClasses) {
      assert.equal(classes.includes(forbidden), false, `${module.name}: forbidden class packaged: ${forbidden}`);
    }
    assert.equal(classes.some((entry) => /cacophony/i.test(entry)), false, `${module.name}: Cacophony class leaked`);

    const artifact = module.name.replace(/^sdk-/u, "").replace(/-android$/u, "");
    const baseline = readFileSync(join(repositoryRoot, "android", "sdk-api", `${artifact}.api.txt`), "utf8");
    const actualApi = snapshotSdkApi({ artifact, jar: classesJar, excludePrefixes: module.apiExcludePrefixes });
    assert.equal(actualApi, baseline, `${module.name}: public binary API changed without migration baseline update`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test("Android SDK wrapper modules reuse canonical source with strict isolated boundaries", () => {
  const settings = text(join(androidRoot, "settings.gradle.kts"));
  for (const module of modules) {
    const directory = join(androidRoot, module.name);
    assert.ok(existsSync(directory), `${module.name}: module directory missing`);
    assert.match(settings, new RegExp(`include\\(\":${module.name}\"\\)`));

    const build = text(join(directory, "build.gradle.kts"));
    assert.match(build, /(id\("com\.android\.library"\)|alias\(libs\.plugins\.android\.library\))/);
    assert.match(build, /compileSdk\s*=\s*36/);
    assert.match(build, /minSdk\s*=\s*26/);
    assert.ok(build.includes(module.source), `${module.name}: canonical source mapping missing`);
    assert.match(build, /consumerProguardFiles\("consumer-rules\.pro"\)/);
    assert.match(build, /LockMode\.STRICT/);
    assert.doesNotMatch(build, /compose\.desktop|currentOs|sharedUserId|bearer|getBearer|cacophony/i);

    assert.ok(existsSync(join(directory, "consumer-rules.pro")), `${module.name}: consumer rules missing`);
    assert.ok(existsSync(join(directory, "gradle.lockfile")), `${module.name}: strict lock missing`);
    const artifact = module.name.replace(/^sdk-/u, "").replace(/-android$/u, "");
    assert.ok(existsSync(join(androidRoot, "sdk-api", `${artifact}.api.txt`)), `${module.name}: API baseline missing`);
  }

  const workspaceBuild = text(join(androidRoot, "sdk-workspace-ui-android", "build.gradle.kts"));
  assert.match(workspaceBuild, /exclude\("\*\*\/WorkspaceFixtureApp\.kt"\)/);
});

test("built Android SDK AARs expose canonical classes without desktop native or Cacophony payload", (context) => {
  const aarRoot = process.env.PI_DROID_AAR_DIR;
  if (!aarRoot) {
    context.skip("set PI_DROID_AAR_DIR to inspect assembled AARs");
    return;
  }
  for (const module of modules) {
    const aarPath = join(aarRoot, `${module.name}-debug.aar`);
    assert.ok(existsSync(aarPath), `${basename(aarPath)} missing`);
    inspectAar(module, aarPath);
  }
});
