import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InstalledPiPackageError,
  resolveInstalledPiPackageResources,
} from "../dist/installed-package-resources.js";

async function fixture(t) {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-daemon-installed-package-"));
  const cwd = join(agentDir, "workspace");
  await mkdir(cwd);
  t.after(async () => rm(agentDir, { recursive: true, force: true }));
  return { agentDir, cwd };
}

async function createPackage(agentDir) {
  const root = join(agentDir, "fixture-package");
  await Promise.all([
    mkdir(join(root, "extensions"), { recursive: true }),
    mkdir(join(root, "skills", "demo"), { recursive: true }),
    mkdir(join(root, "prompts"), { recursive: true }),
    mkdir(join(root, "themes"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "extensions", "one.mjs"), "export default function () {}\n"),
    writeFile(join(root, "extensions", "two.mjs"), "export default function () {}\n"),
    writeFile(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n"),
    writeFile(join(root, "prompts", "review.md"), "Review this.\n"),
    writeFile(join(root, "themes", "fixture.json"), JSON.stringify({ name: "fixture", colors: {} })),
    writeFile(join(root, "package.json"), JSON.stringify({
      name: "fixture-package",
      pi: {
        extensions: ["./extensions/*.mjs"],
        skills: ["./skills"],
        prompts: ["./prompts"],
        themes: ["./themes"],
      },
    })),
  ]);
  return root;
}

async function settings(agentDir, value, mode = 0o600) {
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify(value)}\n`, { mode });
}

test("resolves only enabled resources from an already-installed local Pi package", async (t) => {
  const { agentDir, cwd } = await fixture(t);
  const root = await createPackage(agentDir);
  await settings(agentDir, {
    packages: [{
      source: "./fixture-package",
      extensions: ["extensions/one.mjs"],
    }],
  });
  const resolved = await resolveInstalledPiPackageResources({ cwd, agentDir });
  assert.deepEqual(resolved.extensions, [join(root, "extensions", "one.mjs")]);
  assert.equal(resolved.extensions.includes(join(root, "extensions", "two.mjs")), false);
  assert.deepEqual(resolved.skills, [join(root, "skills", "demo", "SKILL.md")]);
  assert.deepEqual(resolved.promptTemplates, [join(root, "prompts", "review.md")]);
  assert.deepEqual(resolved.themes, [join(root, "themes", "fixture.json")]);
});

test("resolves a managed npm install without executing npm", async (t) => {
  const { agentDir, cwd } = await fixture(t);
  const root = join(agentDir, "npm", "node_modules", "fixture-installed");
  await mkdir(join(root, "extensions"), { recursive: true });
  await writeFile(join(root, "extensions", "fixture.mjs"), "export default function () {}\n");
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "fixture-installed",
    version: "1.2.3",
    pi: { extensions: ["./extensions/fixture.mjs"] },
  }));
  await settings(agentDir, { packages: ["npm:fixture-installed@1.2.3"] });
  const bin = join(agentDir, "bin");
  const marker = join(agentDir, "npm-invoked");
  await mkdir(bin);
  await writeFile(join(bin, "npm"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 99\n`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  let resolved;
  try {
    resolved = await resolveInstalledPiPackageResources({ cwd, agentDir });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  assert.deepEqual(resolved.extensions, [join(root, "extensions", "fixture.mjs")]);
  await assert.rejects(import("node:fs/promises").then(({ stat }) => stat(marker)), { code: "ENOENT" });
});

test("an empty package list resolves no authority", async (t) => {
  const { agentDir, cwd } = await fixture(t);
  await settings(agentDir, { packages: [] });
  assert.deepEqual(await resolveInstalledPiPackageResources({ cwd, agentDir }), {
    extensions: [],
    skills: [],
    promptTemplates: [],
    themes: [],
  });
});

test("missing packages fail without invoking installer authority or disclosing sources", async (t) => {
  const { agentDir, cwd } = await fixture(t);
  const missing = "npm:this-package-must-not-be-installed-by-pi-daemon-987654321";
  const bin = join(agentDir, "bin");
  const marker = join(agentDir, "package-manager-was-invoked");
  await mkdir(bin);
  const npm = join(bin, "npm");
  await writeFile(npm, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 99\n`, { mode: 0o700 });
  await settings(agentDir, { packages: [missing] });
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    await assert.rejects(
      resolveInstalledPiPackageResources({ cwd, agentDir }),
      (error) =>
        error instanceof InstalledPiPackageError &&
        error.code === "installed_package_unavailable" &&
        !error.message.includes(missing),
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  await assert.rejects(
    import("node:fs/promises").then(({ stat }) => stat(marker)),
    { code: "ENOENT" },
  );
  await assert.rejects(
    import("node:fs/promises").then(({ stat }) => stat(join(agentDir, "npm", "node_modules", "this-package-must-not-be-installed-by-pi-daemon-987654321"))),
    { code: "ENOENT" },
  );
});

test("settings bounds, ownership mode and package filter shapes fail closed", async (t) => {
  const { agentDir, cwd } = await fixture(t);
  await settings(agentDir, { packages: [{ source: "./fixture", credential: "forbidden" }] });
  await assert.rejects(
    resolveInstalledPiPackageResources({ cwd, agentDir }),
    (error) => error instanceof InstalledPiPackageError && error.code === "installed_package_settings_invalid",
  );

  await settings(agentDir, { packages: [] }, 0o666);
  await chmod(join(agentDir, "settings.json"), 0o666);
  await assert.rejects(
    resolveInstalledPiPackageResources({ cwd, agentDir }),
    (error) => error instanceof InstalledPiPackageError && error.code === "installed_package_settings_invalid",
  );
});
