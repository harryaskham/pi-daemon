import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const projectRoot = new URL("..", import.meta.url);

async function runWithStreamFailure(preload, entrypoint, args, stream, code) {
  const child = spawn(
    process.execPath,
    ["--import", preload, entrypoint, ...args],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PI_DAEMON_TEST_STREAM: stream,
        PI_DAEMON_TEST_STREAM_ERROR: code,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  return { ...result, stdout, stderr };
}

test("both CLI entrypoints treat stdout and stderr EPIPE as a quiet closed consumer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-epipe-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const preload = join(root, "fail-stream.mjs");
  await writeFile(
    preload,
    `const stream = process.env.PI_DAEMON_TEST_STREAM === "stderr" ? process.stderr : process.stdout;
const code = process.env.PI_DAEMON_TEST_STREAM_ERROR;
stream.write = () => {
  queueMicrotask(() => stream.emit("error", Object.assign(new Error("synthetic-" + code), { code })));
  return true;
};
`,
  );

  const cases = [
    ["dist/cli.js", ["help"], "stdout"],
    ["dist/cli.js", ["not-a-command"], "stderr"],
    ["dist/rpc-stdio-cli.js", ["--help"], "stdout"],
    ["dist/rpc-stdio-cli.js", [], "stderr"],
  ];
  for (const [entrypoint, args, stream] of cases) {
    const result = await runWithStreamFailure(preload, entrypoint, args, stream, "EPIPE");
    assert.deepEqual(
      { exitCode: result.exitCode, signal: result.signal },
      { exitCode: 0, signal: null },
      `${entrypoint} ${args.join(" ")} ${stream}`,
    );
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /EPIPE|synthetic-|node:events/);
  }

  const unrelated = await runWithStreamFailure(
    preload,
    "dist/cli.js",
    ["help"],
    "stdout",
    "EIO",
  );
  assert.notEqual(unrelated.exitCode, 0);
  assert.match(unrelated.stderr, /synthetic-EIO/);
});
