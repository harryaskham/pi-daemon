import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runRpcStdioCli } from "../dist/rpc-stdio-cli.js";

const TOKEN = "rpc-cli-fixture-token-0123456789";

function io(environment = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.setEncoding("utf8");
  stderr.setEncoding("utf8");
  stdout.on("data", (chunk) => (out += chunk));
  stderr.on("data", (chunk) => (err += chunk));
  return {
    value: { stdin, stdout, stderr, environment },
    stdout: () => out,
    stderr: () => err,
  };
}

class CompletedBridge {
  async run() {
    return { code: 0, reconnects: 0, gaps: 0 };
  }
  stop() {}
}

test("RPC stdio CLI accepts one memory-only environment bearer without printing it", async () => {
  const streams = io({ PI_DAEMON_BEARER_TOKEN: TOKEN });
  let captured;
  const code = await runRpcStdioCli(
    ["--session", "exact-session", "--url", "http://127.0.0.1:7463"],
    streams.value,
    {
      createBridge(options) {
        captured = options;
        return new CompletedBridge();
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(captured.bearerToken, TOKEN);
  assert.equal(captured.sessionRef, "exact-session");
  assert.equal(streams.stdout().includes(TOKEN), false);
  assert.equal(streams.stderr().includes(TOKEN), false);
});

test("RPC stdio CLI bearer failures are singular, bounded, and path-redacted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-rpc-cli-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const tokenFile = join(root, "private-token-name");
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o644);

  const permissive = io();
  assert.equal(
    await runRpcStdioCli(
      ["--session", "session-a", "--token-file", tokenFile],
      permissive.value,
    ),
    1,
  );
  assert.match(permissive.stderr(), /owner-only|failed safely/);
  assert.equal(permissive.stderr().includes(tokenFile), false);
  assert.equal(permissive.stderr().includes(TOKEN), false);

  const conflicting = io({ PI_DAEMON_BEARER_TOKEN: TOKEN });
  assert.equal(
    await runRpcStdioCli(
      ["--session", "session-a", "--token-file", tokenFile],
      conflicting.value,
    ),
    1,
  );
  assert.match(conflicting.stderr(), /mutually exclusive/);
  assert.equal(conflicting.stderr().includes(TOKEN), false);
});

test("RPC stdio CLI help and version never require credentials", async () => {
  const help = io();
  assert.equal(await runRpcStdioCli(["--help"], help.value), 0);
  assert.match(help.stdout(), /pi-daemon-rpc --session/);
  assert.equal(help.stderr(), "");

  const version = io();
  assert.equal(await runRpcStdioCli(["--version"], version.value), 0);
  assert.match(version.stdout(), /^0\.1\.0\n$/);
  assert.equal(version.stderr(), "");
});
