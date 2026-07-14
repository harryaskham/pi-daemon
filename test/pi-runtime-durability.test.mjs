import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import { FileDurabilityStore } from "../dist/durability.js";
import { Multiplexer } from "../dist/multiplexer.js";
import { PiSessionFactory } from "../dist/pi-adapter.js";
import { FileSessionCatalog } from "../dist/session-catalog.js";

const modelHarness = () => {
  const seedRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const model = seedRegistry.getAll()[0];
  assert.ok(model, "Pi built-in model registry must not be empty");
  const authStorage = AuthStorage.inMemory({
    [model.provider]: { type: "api_key", key: "test-only-key" },
  });
  return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage), model };
};

class RecordingFactory {
  adapters = [];
  requests = [];

  constructor(delegate) {
    this.delegate = delegate;
  }

  async open(request) {
    this.requests.push(structuredClone(request));
    const adapter = await this.delegate.open(request);
    this.adapters.push(adapter);
    return adapter;
  }

  readiness() {
    return this.delegate.readiness();
  }
}

const openCommand = (cwd, model) => ({
  protocolVersion: "1.0",
  requestId: "open-real-runtime",
  operation: "open",
  sessionId: "real-runtime",
  generation: 1,
  payload: {
    cwd,
    session: { mode: "new" },
    model: { provider: model.provider, id: model.id, thinkingLevel: "off" },
    resources: {
      extensions: "none",
      skills: "none",
      promptTemplates: "none",
      themes: "none",
      contextFiles: "none",
      tools: "none",
    },
  },
});

const queuedWake = {
  protocolVersion: "1.0",
  requestId: "queued-after-loss",
  operation: "wake",
  sessionId: "real-runtime",
  generation: 1,
  idempotencyKey: "queued-after-loss",
  payload: { prompt: "must not run in a different conversation" },
};

test("real Pi conversation identity survives restart and loss blocks queued replay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-runtime-durability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  await Promise.all([mkdir(stateDir, { mode: 0o700 }), mkdir(agentDir), mkdir(cwd)]);
  const { authStorage, modelRegistry, model } = modelHarness();
  const makeFactory = () =>
    new RecordingFactory(
      new PiSessionFactory({
        stateDir,
        agentDir,
        allowedRoots: [cwd],
        authStorage,
        modelRegistry,
      }),
    );
  const makeMux = (factory) =>
    new Multiplexer({
      factory,
      durability: new FileDurabilityStore({ stateDir }),
      catalog: new FileSessionCatalog({ stateDir }),
    });

  const firstFactory = makeFactory();
  const first = makeMux(firstFactory);
  await first.recover();
  await first.open(openCommand(cwd, model));
  const identity = firstFactory.adapters[0].identity();
  assert.ok(identity.sessionFile);
  assert.equal((await stat(identity.sessionFile)).mode & 0o777, 0o600);
  await first.dispose();

  const restartedFactory = makeFactory();
  const restarted = makeMux(restartedFactory);
  const restartedReport = await restarted.recover();
  assert.deepEqual(restartedReport.opened, ["real-runtime"]);
  assert.deepEqual(restartedFactory.adapters[0].identity(), identity);
  assert.deepEqual(restartedFactory.requests[0].session, {
    mode: "open",
    path: identity.sessionFile,
  });
  await restarted.dispose();

  await rm(identity.sessionFile);
  const journal = new FileDurabilityStore({ stateDir });
  await journal.recover();
  await journal.beginRequest(queuedWake);

  const missingFactory = makeFactory();
  const missing = makeMux(missingFactory);
  const missingReport = await missing.recover();
  assert.deepEqual(missingReport.opened, []);
  assert.deepEqual(missingReport.replayed, []);
  assert.equal(missingFactory.adapters.length, 0);
  assert.ok(missingReport.failures.some((failure) => failure.sessionId === "real-runtime"));

  await writeFile(identity.sessionFile, "not a Pi JSONL session\n", { mode: 0o600 });
  await chmod(identity.sessionFile, 0o600);
  const corruptFactory = makeFactory();
  const corrupt = makeMux(corruptFactory);
  const corruptReport = await corrupt.recover();
  assert.deepEqual(corruptReport.opened, []);
  assert.deepEqual(corruptReport.replayed, []);
  assert.equal(corruptFactory.adapters.length, 0);
  assert.ok(corruptReport.failures.some((failure) => failure.sessionId === "real-runtime"));
});
