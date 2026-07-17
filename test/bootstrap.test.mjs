import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { loadServiceBearer } from "../dist/api-auth.js";
import { bootstrapServicePaths } from "../dist/bootstrap.js";

const AUTH = `${JSON.stringify({ "github-copilot": { type: "oauth", refresh: "fixture" } }, null, 2)}\n`;

async function harness(t, name = "pi-daemon-bootstrap-") {
  const root = await mkdtemp(join(tmpdir(), name));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourceDirectory = join(root, "source");
  await mkdir(sourceDirectory, { mode: 0o700 });
  const source = join(sourceDirectory, "auth.json");
  await writeFile(source, AUTH, { mode: 0o600 });
  return {
    root,
    source,
    stateDir: join(root, "state", "instance"),
    socketPath: join(root, "run", "instance", "pi-daemon.sock"),
    agentDir: join(root, "agent", "instance"),
    tokenFile: join(root, "config", "instance", "api-token"),
  };
}

test("first launch creates private service paths, auth seed, and bearer exactly once", async (t) => {
  const paths = await harness(t);
  const first = await bootstrapServicePaths({
    ...paths,
    authSeedFile: paths.source,
    authSeedRequired: true,
    apiTokenFile: paths.tokenFile,
  });
  assert.deepEqual(first, { bearerCreated: true, auth: "seeded" });

  for (const directory of [
    paths.stateDir,
    dirname(paths.socketPath),
    paths.agentDir,
    dirname(paths.tokenFile),
  ]) {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  }
  const destination = join(paths.agentDir, "auth.json");
  assert.equal(await readFile(destination, "utf8"), AUTH);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.tokenFile)).mode & 0o777, 0o600);

  const token = (await readFile(paths.tokenFile, "utf8")).trimEnd();
  assert.equal(
    loadServiceBearer({ tokenFile: paths.tokenFile, environment: {} }).authenticator.authenticate(
      `Bearer ${token}`,
    ),
    true,
  );

  await writeFile(paths.source, `${JSON.stringify({ replacement: true })}\n`, { mode: 0o600 });
  const second = await bootstrapServicePaths({
    ...paths,
    authSeedFile: paths.source,
    authSeedRequired: true,
    apiTokenFile: paths.tokenFile,
  });
  assert.deepEqual(second, { bearerCreated: false, auth: "existing" });
  assert.equal(await readFile(destination, "utf8"), AUTH, "seed must never overwrite auth");
  assert.equal((await readFile(paths.tokenFile, "utf8")).trimEnd(), token, "bearer must be stable");
});

test("concurrent first launches publish only complete auth and bearer files", async (t) => {
  const paths = await harness(t, "pi-daemon-bootstrap-race-");
  const options = {
    ...paths,
    authSeedFile: paths.source,
    authSeedRequired: true,
    apiTokenFile: paths.tokenFile,
  };
  const results = await Promise.all([
    bootstrapServicePaths(options),
    bootstrapServicePaths(options),
  ]);
  assert.equal(results.filter((result) => result.auth === "seeded").length, 1);
  assert.equal(results.filter((result) => result.bearerCreated).length, 1);
  assert.equal(await readFile(join(paths.agentDir, "auth.json"), "utf8"), AUTH);
  assert.doesNotThrow(() => loadServiceBearer({ tokenFile: paths.tokenFile, environment: {} }));
});

test("implicit absent auth seeds are nonfatal while explicit absent seeds fail", async (t) => {
  const paths = await harness(t, "pi-daemon-bootstrap-missing-");
  const missing = join(paths.root, "missing-auth.json");
  const result = await bootstrapServicePaths({
    ...paths,
    authSeedFile: missing,
    apiTokenFile: paths.tokenFile,
  });
  assert.equal(result.auth, "source_missing");

  const other = await harness(t, "pi-daemon-bootstrap-required-");
  await assert.rejects(
    bootstrapServicePaths({
      ...other,
      authSeedFile: join(other.root, "missing-auth.json"),
      authSeedRequired: true,
    }),
    (error) => error instanceof Error && "code" in error && error.code === "ENOENT",
  );
});

test("bootstrap rejects permissive or symlinked seed and bearer files", async (t) => {
  const permissive = await harness(t, "pi-daemon-bootstrap-permissive-");
  await chmod(permissive.source, 0o644);
  await assert.rejects(
    bootstrapServicePaths({
      ...permissive,
      authSeedFile: permissive.source,
      authSeedRequired: true,
    }),
    /owner-only/,
  );

  const linked = await harness(t, "pi-daemon-bootstrap-symlink-");
  const seedLink = join(linked.root, "seed-link.json");
  await symlink(linked.source, seedLink);
  await assert.rejects(
    bootstrapServicePaths({ ...linked, authSeedFile: seedLink, authSeedRequired: true }),
    /non-symlink/,
  );

  const token = await harness(t, "pi-daemon-bootstrap-token-link-");
  const realToken = join(token.root, "real-token");
  await writeFile(realToken, "fixture-service-bearer-0123456789\n", { mode: 0o600 });
  await mkdir(join(token.root, "token-parent"), { mode: 0o700 });
  const tokenLink = join(token.root, "token-parent", "api-token");
  await symlink(realToken, tokenLink);
  await assert.rejects(
    bootstrapServicePaths({ ...token, apiTokenFile: tokenLink }),
    /non-symlink/,
  );
});

test("bootstrap bounds and validates auth seed content before copying", async (t) => {
  const invalid = await harness(t, "pi-daemon-bootstrap-invalid-json-");
  await writeFile(invalid.source, "not-json\n", { mode: 0o600 });
  await assert.rejects(
    bootstrapServicePaths({ ...invalid, authSeedFile: invalid.source, authSeedRequired: true }),
    /valid JSON/,
  );

  const oversized = await harness(t, "pi-daemon-bootstrap-oversized-auth-");
  await writeFile(oversized.source, `{"value":"${"x".repeat(1024 * 1024)}"}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    bootstrapServicePaths({ ...oversized, authSeedFile: oversized.source, authSeedRequired: true }),
    /1 MiB/,
  );
});

test("bootstrap rejects permissive daemon-owned directories", async (t) => {
  const paths = await harness(t, "pi-daemon-bootstrap-permissive-dir-");
  await mkdir(paths.stateDir, { recursive: true, mode: 0o755 });
  await assert.rejects(
    bootstrapServicePaths(paths),
    (error) => error instanceof Error && "code" in error && error.code === "insecure_state_path",
  );
});

test("bootstrap rejects overlapping state and Pi credential roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-bootstrap-overlap-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    bootstrapServicePaths({
      stateDir: join(root, "state"),
      socketPath: join(root, "state", "run", "daemon.sock"),
      agentDir: join(root, "state", "agent"),
    }),
    /must not overlap/,
  );
});
