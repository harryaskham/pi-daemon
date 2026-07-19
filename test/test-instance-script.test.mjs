import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
  assert.match(source, /init-config/);
  assert.match(source, /PI_DAEMON_TEST_ALLOWED_ROOT/);
  assert.match(source, /PI_DAEMON_TEST_API_PORT/);
  assert.match(source, /PI_DAEMON_TEST_WEB_PORT/);
  assert.match(source, /tmux -L "\$TMUX_SOCKET"/);
  assert.match(source, /tmux_cmd new-session -d -s "\$TMUX_SESSION"/);
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
    PI_DAEMON_TEST_TMUX_SOCKET: `pi-daemon-test-socket-${process.pid}`,
  };
  const paths = await execFileAsync("bash", [script, "paths"], { env: environment });
  assert.match(paths.stdout, /instance=fixture/);
  assert.match(paths.stdout, new RegExp(`state=${join(root, "state").replaceAll("/", "\\/")}`));
  const status = await execFileAsync("bash", [script, "status"], { env: environment });
  assert.match(status.stdout, /source_commit=missing/);
  assert.match(status.stdout, /nix_result=missing/);
  assert.match(status.stdout, /runtime=stopped/);
});

test("init-config creates a complete owner-private node-local config once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-test-config-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const config = join(root, "config", "config.yaml");
  const environment = {
    ...process.env,
    HOME: join(root, "home"),
    PI_DAEMON_TEST_INSTANCE: "aurora-test",
    PI_DAEMON_TEST_SOURCE: join(root, "source"),
    PI_DAEMON_TEST_STATE: join(root, "state"),
    PI_DAEMON_TEST_CONFIG: config,
    PI_DAEMON_TEST_AGENT_DIR: join(root, "agent"),
    PI_DAEMON_TEST_ALLOWED_ROOT: join(root, "work"),
    PI_DAEMON_TEST_NORMAL_SESSIONS_ROOT: join(root, "normal-sessions"),
    PI_DAEMON_TEST_API_PORT: "18473",
    PI_DAEMON_TEST_WEB_PORT: "18474",
    PI_DAEMON_TEST_TMUX: `pi-daemon-test-config-${process.pid}`,
    PI_DAEMON_TEST_TMUX_SOCKET: `pi-daemon-test-config-socket-${process.pid}`,
  };
  const initialized = await execFileAsync("bash", [script, "init-config"], { env: environment });
  assert.match(initialized.stdout, /created test instance config/);
  assert.equal((await stat(config)).mode & 0o777, 0o600);
  const yaml = await readFile(config, "utf8");
  assert.match(yaml, /instance: 'aurora-test'/);
  assert.match(yaml, /port: 18473/);
  assert.match(yaml, /port: 18474/);
  assert.match(yaml, /mode: embedded/);
  assert.match(yaml, /maxSessions: 10000/);
  assert.equal(/token|bearer|password/iu.test(yaml), false);

  await execFileAsync("bash", [script, "init-config"], { env: environment });
  assert.equal(await readFile(config, "utf8"), yaml, "init-config must never overwrite");
});
