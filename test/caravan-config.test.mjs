import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parse } from "yaml";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const readPolicy = async () => {
  const source = await readFile(`${repositoryRoot}/.caravan/config.yaml`, "utf8");
  return { policy: parse(source), source };
};

test("Caravan policy opts into reviewed GitHub-native stacks within the external scheduler budget", async () => {
  const { policy, source } = await readPolicy();

  assert.equal(policy.version, 1);
  assert.equal(policy.repository, "harryaskham/pi-daemon");
  assert.equal(policy.min_cara_version, "0.0.92");
  assert.equal(policy.stack_type, "github");
  assert.equal(policy.force_merge, false);
  assert.equal(policy.rebase_on_join, false);
  assert.equal(policy.max_caravan_length, 8);
  assert.deepEqual(policy.stack_rollout, {
    mutations_opt_in: true,
    reviewed_by: "harry/cacophony-config-pr-114",
  });
  assert.deepEqual(policy.github_auth, { mode: "ambient" });

  assert.equal(policy.sync.head_merge_actor, "caravan");
  assert.equal(policy.sync.max_caravans, 1);
  assert.deepEqual(policy.sync.actions, { join_unlabelled_prs: true });
  assert.deepEqual(policy.sync.terminal_red, { action: "park" });
  assert.equal(policy.sync.max_candidates_per_tick, 8);
  assert.equal(policy.sync.max_mutations_per_tick, 64);
  assert.equal(policy.sync.max_github_requests_per_tick, 256);
  assert.equal(policy.command_timeout_secs, 60);
  assert.equal(policy.sync.max_duration_secs, 480);
  assert.equal(
    "loop" in policy,
    false,
    "Cacophony owns scheduling; the repository must not add a second loop",
  );
  assert.deepEqual(policy.hooks, {});

  assert.doesNotMatch(source, /force_merge:\s*true|rebase_on_join:\s*true/);
});

test("Caravan lifecycle uses the reviewed rolling system runtime wrapper", async () => {
  const wrapperPath = `${repositoryRoot}/scripts/cara-runtime.sh`;
  const [wrapper, metadata] = await Promise.all([
    readFile(wrapperPath, "utf8"),
    stat(wrapperPath),
  ]);

  assert.notEqual(metadata.mode & 0o111, 0, "the configured lifecycle wrapper must be executable");
  assert.match(wrapper, /--source/);
  assert.match(wrapper, /system\|installed\|auto/);
  assert.match(wrapper, /env -u NIX_LD -u NIX_LD_LIBRARY_PATH -u LD_LIBRARY_PATH/);
  assert.match(wrapper, /caco-cara-runtime-receipt source=system/);
  assert.match(wrapper, /exec "\$\{clean_env\[@\]\}" "\$resolved" "\$@"/);
  assert.doesNotMatch(wrapper, /gh[pousr]_[A-Za-z0-9]/);
});
