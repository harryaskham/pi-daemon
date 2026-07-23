import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPiDaemonConfig } from "../dist/config.js";
import {
  DashboardSessionDefaultsError,
  assertDashboardSessionDraftWithinRuntimePolicy,
  resolveDashboardSessionDefaults,
} from "../dist/dashboard-session-defaults.js";
import {
  DashboardSessionDraftService,
  FileDashboardSessionDraftStore,
  dashboardSessionDraftSpecToSessionSpec,
} from "../dist/dashboard-session-drafts.js";

async function harness(t) {
  const home = await mkdtemp(join(tmpdir(), "pi-daemon-session-defaults-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agentDir = join(home, ".pi", "agent");
  const configDir = join(home, ".config", "pi", "daemon", "main");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(configDir, { recursive: true })]);
  const settings = join(agentDir, "settings.json");
  await writeFile(settings, `${JSON.stringify({
    trueDefaultProvider: "github-copilot",
    trueDefaultModel: "gpt-5.6-sol",
    trueDefaultThinkingLevel: "high",
    packages: ["secret-server-only-package-list"],
  })}\n`, { mode: 0o600 });
  const extension = join(home, "reviewed-extension.mjs");
  await writeFile(extension, "export default function () {}\n", { mode: 0o600 });
  const configPath = join(configDir, "config.yaml");
  await writeFile(configPath, `
web:
  runtimePolicy:
    tools: { mode: default }
    resources:
      extensions: [${JSON.stringify(extension)}]
      projectTrust: approve
      noExtensions: false
      noSkills: false
      noPromptTemplates: false
      noThemes: false
      noContextFiles: false
      inheritInstalledPackages: true
    settings:
      defaultProjectTrust: always
      steeringMode: all
      followUpMode: all
  sessionDefaults:
    cwd: "~"
    piSettingsFile: "~/.pi/agent/settings.json"
    inheritRuntimePolicy: true
`, { mode: 0o600 });
  const loaded = await loadPiDaemonConfig({
    cliConfigPath: configPath,
    cliInstance: "main",
    homeDirectory: home,
  });
  return { home, settings, extension, configPath, loaded };
}

test("owner defaults inherit Pi model settings and only browser-safe runtime authority", async (t) => {
  const h = await harness(t);
  const defaults = await resolveDashboardSessionDefaults(h.loaded);
  assert.deepEqual(defaults, {
    spec: {
      cwd: h.home,
      persistence: "persistent",
      model: { provider: "github-copilot", id: "gpt-5.6-sol", thinkingLevel: "high" },
      tools: { mode: "default" },
      resources: {
        noExtensions: false,
        noSkills: false,
        noPromptTemplates: false,
        noThemes: false,
        noContextFiles: false,
        projectTrust: "approve",
      },
      isolation: { mode: "unisolated" },
    },
    sources: { cwd: "configured", model: "pi-settings", authority: "runtime-policy" },
  });
  const serialized = JSON.stringify(defaults);
  assert.equal(serialized.includes(h.settings), false);
  assert.equal(serialized.includes(h.extension), false);
  assert.equal(serialized.includes("secret-server-only-package-list"), false);

  const materialized = dashboardSessionDraftSpecToSessionSpec(
    defaults.spec,
    h.loaded.config.web.runtimePolicy,
  );
  assert.deepEqual(materialized.resources.extensions, [h.extension]);
  assert.equal(materialized.resources.projectTrust, "approve");
  assert.equal(materialized.resources.noContextFiles, false);
  assert.equal(materialized.resources.inheritInstalledPackages, true);
  assert.equal("inheritInstalledPackages" in defaults.spec.resources, false);
  assert.deepEqual(materialized.settings, {
    defaultProjectTrust: "always",
    steeringMode: "all",
    followUpMode: "all",
  });
});

test("draft authority may be reduced but never exceed the owner runtime policy", async (t) => {
  const h = await harness(t);
  const defaults = await resolveDashboardSessionDefaults(h.loaded);
  const policy = h.loaded.config.web.runtimePolicy;
  assert.doesNotThrow(() => assertDashboardSessionDraftWithinRuntimePolicy(defaults.spec, policy));
  assert.doesNotThrow(() => assertDashboardSessionDraftWithinRuntimePolicy({
    ...defaults.spec,
    tools: { mode: "none" },
    resources: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      projectTrust: "deny",
    },
  }, policy));
  assert.throws(
    () => assertDashboardSessionDraftWithinRuntimePolicy(defaults.spec, undefined),
    (error) => error instanceof DashboardSessionDefaultsError && error.code === "draft_authority_denied",
  );
  assert.throws(
    () => assertDashboardSessionDraftWithinRuntimePolicy({
      ...defaults.spec,
      tools: { mode: "allowlist", include: ["not-reviewed"] },
      resources: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        projectTrust: "deny",
      },
    }, { tools: { mode: "allowlist", include: ["read"] } }),
    /tool allowlist exceeds/,
  );
});

test("draft creation enforces owner authority while still allowing a restrictive downscope", async (t) => {
  const h = await harness(t);
  const defaults = await resolveDashboardSessionDefaults(h.loaded);
  const service = new DashboardSessionDraftService({
    store: new FileDashboardSessionDraftStore({ stateDir: h.home }),
    allowedRoots: [h.home],
    authorizeSpec: (spec) =>
      assertDashboardSessionDraftWithinRuntimePolicy(spec, h.loaded.config.web.runtimePolicy),
  });
  await service.recover();
  assert.equal((await service.create({
    requestId: "default-create",
    idempotencyKey: "default-create-key",
    draftId: "default-create",
    spec: defaults.spec,
  })).spec.tools.mode, "default");
  const restricted = new DashboardSessionDraftService({
    store: new FileDashboardSessionDraftStore({ stateDir: join(h.home, "restricted-state") }),
    allowedRoots: [h.home],
    authorizeSpec: (spec) => assertDashboardSessionDraftWithinRuntimePolicy(spec, undefined),
  });
  await restricted.recover();
  await assert.rejects(restricted.create({
    requestId: "excess-create",
    idempotencyKey: "excess-create-key",
    draftId: "excess-create",
    spec: defaults.spec,
  }), /tool authority exceeds/);
  const downscoped = {
    ...defaults.spec,
    tools: { mode: "none" },
    resources: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      projectTrust: "deny",
    },
  };
  assert.equal((await restricted.create({
    requestId: "restricted-create",
    idempotencyKey: "restricted-create-key",
    draftId: "restricted-create",
    spec: downscoped,
  })).spec.tools.mode, "none");
});

test("configured default cwd must resolve beneath an allowed workload root", async (t) => {
  const h = await harness(t);
  await assert.rejects(
    resolveDashboardSessionDefaults(h.loaded, { allowedRoots: [join(h.home, "elsewhere")] }),
    (error) => error instanceof DashboardSessionDefaultsError && error.code === "session_defaults_cwd_not_allowed",
  );
  assert.equal(
    (await resolveDashboardSessionDefaults(h.loaded, { allowedRoots: [h.home] })).spec.cwd,
    await realpath(h.home),
  );
});

test("Pi settings source is bounded, owner-controlled, and fails closed", async (t) => {
  const h = await harness(t);
  await chmod(h.settings, 0o666);
  await assert.rejects(
    resolveDashboardSessionDefaults(h.loaded),
    (error) => error instanceof DashboardSessionDefaultsError && error.code === "pi_settings_insecure_mode",
  );
});
