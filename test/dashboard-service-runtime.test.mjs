import assert from "node:assert/strict";
import test from "node:test";

import { dashboardActivationRuntimeSpec } from "../dist/dashboard-service-runtime.js";

test("Dashboard activation defaults to no tools or ambient resources", () => {
  assert.deepEqual(dashboardActivationRuntimeSpec("/work", undefined), {
    cwd: "/work",
    target: { mode: "memory" },
    tools: { mode: "none" },
    resources: {
      extensions: [],
      skills: [],
      promptTemplates: [],
      themes: [],
      noContextFiles: true,
    },
    isolation: { mode: "unisolated" },
  });
});

test("Dashboard activation applies only the explicit trusted runtime policy", () => {
  const policy = {
    model: {
      provider: "github-copilot",
      id: "gpt-5.6-sol",
      thinkingLevel: "high",
    },
    tools: { mode: "none" },
    resources: {
      extensions: ["/reviewed/model-shortcut.mjs"],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      projectTrust: "approve",
    },
    settings: {
      packages: ["git:github.com/harryaskham/agent-utils"],
    },
  };
  const spec = dashboardActivationRuntimeSpec("/work", policy);
  assert.deepEqual(spec, {
    cwd: "/work",
    target: { mode: "memory" },
    model: policy.model,
    tools: policy.tools,
    resources: policy.resources,
    settings: policy.settings,
    isolation: { mode: "unisolated" },
  });
  spec.resources.extensions.push("/mutated.mjs");
  assert.deepEqual(policy.resources.extensions, ["/reviewed/model-shortcut.mjs"]);
});
