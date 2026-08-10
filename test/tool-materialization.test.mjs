import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MATERIALIZED_TOOL_ENTRIES,
  liveToolMaterialization,
  unavailableToolMaterialization,
} from "../dist/tool-materialization.js";

const spec = {
  cwd: "/work",
  target: { mode: "memory" },
  tools: {
    mode: "allowlist",
    include: ["read", "caco_msg_send"],
    exclude: ["write"],
    required: ["read", "caco_msg_send"],
  },
  materialization: {
    source: "managed-profile",
    materializationGeneration: "profile-gen-42",
    digest: "sha256:fixture",
    authorization: { source: "controller", scope: "project:fixture" },
  },
  isolation: { mode: "unisolated" },
};

test("live tool materialization reports source, policy, residency and provenance without paths", () => {
  const materialization = liveToolMaterialization(
    spec,
    [
      { name: "read", sourceClass: "builtin" },
      { name: "write", sourceClass: "builtin" },
      { name: "caco_msg_send", sourceClass: "explicit-extension" },
      { name: "package_tool", sourceClass: "inherited-package" },
    ],
    ["read", "caco_msg_send"],
  );

  assert.deepEqual(materialization.active, ["caco_msg_send", "read"]);
  assert.deepEqual(materialization.required, ["caco_msg_send", "read"]);
  assert.equal(materialization.state, "materialized");
  assert.deepEqual(materialization.provenance, spec.materialization);
  assert.deepEqual(
    materialization.entries.find((entry) => entry.name === "caco_msg_send"),
    {
      name: "caco_msg_send",
      sourceClass: "explicit-extension",
      policyDisposition: "required",
      availability: "resident",
      active: true,
      required: true,
    },
  );
  assert.deepEqual(
    materialization.entries.find((entry) => entry.name === "write"),
    {
      name: "write",
      sourceClass: "builtin",
      policyDisposition: "excluded",
      availability: "resident",
      active: false,
      required: false,
      omissionReason: "excluded_by_policy",
    },
  );
  assert.deepEqual(
    materialization.entries.find((entry) => entry.name === "package_tool"),
    {
      name: "package_tool",
      sourceClass: "inherited-package",
      policyDisposition: "not-selected",
      availability: "resident",
      active: false,
      required: false,
      omissionReason: "not_selected_by_policy",
    },
  );
  assert.equal(JSON.stringify(materialization).includes("/work"), false);
});

test("runtime-disabled registered tools are not misreported as policy exclusions", () => {
  const materialization = liveToolMaterialization(
    { cwd: "/work", target: { mode: "memory" }, tools: { mode: "default" } },
    [{ name: "extension_tool", sourceClass: "explicit-extension" }],
    [],
  );
  assert.deepEqual(materialization.entries[0], {
    name: "extension_tool",
    sourceClass: "explicit-extension",
    policyDisposition: "allowed",
    availability: "resident",
    active: false,
    required: false,
    omissionReason: "inactive_in_runtime",
  });
});

test("dormant materialization never fabricates a resident inventory", () => {
  const materialization = unavailableToolMaterialization(spec, "not-resident");
  assert.equal(materialization.state, "not-resident");
  assert.deepEqual(materialization.active, []);
  assert.deepEqual(
    materialization.entries.map(({ name, availability, omissionReason }) => ({
      name,
      availability,
      omissionReason,
    })),
    [
      { name: "caco_msg_send", availability: "dormant", omissionReason: "runtime_not_resident" },
      { name: "read", availability: "dormant", omissionReason: "runtime_not_resident" },
      { name: "write", availability: "dormant", omissionReason: "runtime_not_resident" },
    ],
  );
});

test("tool inventory output is deterministically bounded", () => {
  const inventory = Array.from({ length: MAX_MATERIALIZED_TOOL_ENTRIES + 100 }, (_, index) => ({
    name: `tool_${String(index).padStart(4, "0")}`,
    sourceClass: "sdk",
  }));
  const required = inventory.at(-1).name;
  const materialization = liveToolMaterialization(
    {
      cwd: "/work",
      target: { mode: "memory" },
      tools: { mode: "allowlist", include: [required], required: [required] },
    },
    inventory,
    inventory.map((entry) => entry.name),
  );
  assert.equal(materialization.entries.length, MAX_MATERIALIZED_TOOL_ENTRIES);
  assert.equal(materialization.active.length, MAX_MATERIALIZED_TOOL_ENTRIES);
  assert.equal(materialization.truncated, true);
  assert.equal(materialization.required[0], required);
  assert.equal(materialization.active.includes(required), true);
  assert.equal(materialization.entries.some((entry) => entry.name === required), true);
});
