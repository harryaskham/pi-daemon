import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(repositoryRoot, "scripts", "pi-daemon-test-instance.sh");

test("rolling test-instance helper is syntax-safe, immutable-build based, and never owns launchd", async () => {
  await chmod(script, 0o755);
  await execFileAsync("bash", ["-n", script]);
  const source = await readFile(script, "utf8");
  assert.match(source, /nix build "\$SOURCE#pi-daemon" --print-build-logs --out-link "\$CURRENT"/);
  assert.match(source, /git -C "\$SOURCE" merge --ff-only "origin\/\$BRANCH"/);
  assert.match(source, /PI_DAEMON_TEST_CONFIG/);
  assert.match(source, /PI_DAEMON_TEST_STATE/);
  assert.match(source, /tmux new-session -d -s "\$TMUX_SESSION"/);
  assert.match(source, /--config %q --instance %q/);
  assert.doesNotMatch(source, /launchctl|systemctl|Authorization|Bearer|token-file/);
});

test("paths and stopped status are side-effect free under isolated overrides", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-test-instance-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const environment = {
    ...process.env,
    PI_DAEMON_TEST_INSTANCE: "fixture",
    PI_DAEMON_TEST_SOURCE: join(root, "source"),
    PI_DAEMON_TEST_STATE: join(root, "state"),
    PI_DAEMON_TEST_CONFIG: join(root, "config.yaml"),
    PI_DAEMON_TEST_TMUX: `pi-daemon-test-${process.pid}`,
  };
  const paths = await execFileAsync("bash", [script, "paths"], { env: environment });
  assert.match(paths.stdout, /instance=fixture/);
  assert.match(paths.stdout, new RegExp(`state=${join(root, "state").replaceAll("/", "\\/")}`));
  const status = await execFileAsync("bash", [script, "status"], { env: environment });
  assert.match(status.stdout, /source_commit=missing/);
  assert.match(status.stdout, /nix_result=missing/);
  assert.match(status.stdout, /runtime=stopped/);
});
