import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SessionConfigurationError,
  parseSessionConfiguration,
  providerApiKeyFromEnvironment,
  requireProvisionedEnvironment,
  toolConfiguration,
  unprovisionedEnvironmentSummary,
} from "../dist/session-config.js";

const fixture = async () =>
  JSON.parse(
    await readFile(new URL("../fixtures/session-api/create.request.json", import.meta.url), "utf8"),
  ).spec;

test("session configuration separates durable policy from a bounded memory-only environment", async () => {
  const input = await fixture();
  const prepared = parseSessionConfiguration(input);

  assert.equal("env" in prepared.persistedSpec, false);
  assert.deepEqual(prepared.environmentSummary, {
    keys: ["CI", "PROVIDER_TOKEN"],
    persistence: "memory-only",
    provisioned: true,
  });
  assert.deepEqual({ ...prepared.environmentOverlay }, {
    CI: "1",
    PROVIDER_TOKEN: "fixture-redacted-value",
  });
  assert.equal(prepared.openRequest.cwd, "/srv/work/project-a");
  assert.equal(prepared.openRequest.agentDir, "/srv/pi-config/agent-a");
  assert.equal(prepared.openRequest.runtimeOptions, prepared.runtimeOptions);
  assert.equal(prepared.runtimeOptions.persistedSpec, prepared.persistedSpec);
  assert.equal(prepared.persistedSpec.isolation.mode, "unisolated");
  assert.deepEqual(toolConfiguration(prepared.persistedSpec), {
    tools: ["read", "bash"],
    excludeTools: ["write"],
  });
  const explicitResources = parseSessionConfiguration({
    cwd: "/work",
    target: { mode: "memory" },
    resources: {
      extensions: ["git:github.com/harryaskham/agent-utils", "./reviewed.mjs"],
      skills: ["npm:reviewed-skills"],
    },
  }).persistedSpec.resources;
  assert.deepEqual(explicitResources.extensions, [
    "git:github.com/harryaskham/agent-utils",
    "/work/reviewed.mjs",
  ]);
  assert.deepEqual(explicitResources.skills, ["npm:reviewed-skills"]);

  assert.deepEqual(
    toolConfiguration(
      parseSessionConfiguration({
        cwd: "/work",
        target: { mode: "memory" },
        tools: { mode: "no-builtin" },
      }).persistedSpec,
    ),
    { noTools: "builtin" },
  );

  const durableProjection = JSON.stringify({
    spec: prepared.persistedSpec,
    environment: prepared.environmentSummary,
  });
  assert.equal(durableProjection.includes("fixture-redacted-value"), false);
  assert.equal(JSON.stringify(prepared.persistedSpec).includes("PROVIDER_TOKEN"), false);

  const restored = unprovisionedEnvironmentSummary(prepared.environmentSummary);
  assert.equal(restored.provisioned, false);
  assert.throws(
    () => requireProvisionedEnvironment(restored, undefined),
    (error) =>
      error instanceof SessionConfigurationError &&
      error.code === "credentials_required" &&
      error.statusClass === "credentials_required",
  );
  assert.doesNotThrow(() =>
    requireProvisionedEnvironment(prepared.environmentSummary, prepared.environmentOverlay),
  );
});

test("configuration errors distinguish invalid, unsupported, and too-large input", () => {
  const cases = [
    {
      value: { cwd: "/work", target: { mode: "memory" }, unknown: true },
      code: "invalid_session_spec",
      statusClass: "invalid",
    },
    {
      value: { cwd: "/work", target: { mode: "memory" }, isolation: { mode: "container" } },
      code: "unsupported_session_configuration",
      statusClass: "unsupported",
    },
    {
      value: { cwd: "/work", target: { mode: "memory" }, env: { TOKEN: "secret" } },
      options: { limits: { maxEnvironmentValueBytes: 2 } },
      code: "session_configuration_too_large",
      statusClass: "too_large",
    },
    {
      value: {
        cwd: "/work",
        target: { mode: "memory" },
        settings: { packages: ["npm:trusted-package"] },
      },
      code: "unsupported_session_configuration",
      statusClass: "unsupported",
    },
  ];
  for (const item of cases) {
    assert.throws(
      () => parseSessionConfiguration(item.value, item.options),
      (error) =>
        error instanceof SessionConfigurationError &&
        error.code === item.code &&
        error.statusClass === item.statusClass &&
        !error.message.includes("secret"),
    );
  }
});

test("provider environment lookup is explicit and never consults process.env", () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "ambient-must-not-win";
  try {
    assert.equal(
      providerApiKeyFromEnvironment("openai", { OPENAI_API_KEY: "session-only" }),
      "session-only",
    );
    assert.equal(providerApiKeyFromEnvironment("openai", {}), undefined);
    assert.equal(providerApiKeyFromEnvironment("custom-provider", { API_KEY: "value" }), undefined);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
