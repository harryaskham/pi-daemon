import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/cli.js";
import {
  DEFAULT_PI_DAEMON_WEB_CONFIG,
  DEFAULT_SESSION_STORAGE_MODE,
  PI_DAEMON_CONFIG_ENV,
  PI_DAEMON_INSTANCE_ENV,
  PiDaemonConfigError,
  loadPiDaemonConfig,
} from "../dist/config.js";
import { PiDaemonClient } from "../dist/client.js";

class EmptyFactory {
  async open() {
    throw new Error("not used by configuration tests");
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-config-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeConfig(root, text, mode = 0o600) {
  const path = join(root, "config.yaml");
  await writeFile(path, text, { mode });
  return path;
}

test("web and session storage defaults are explicit typed inputs", () => {
  assert.equal(DEFAULT_SESSION_STORAGE_MODE, "pi-session-root");
  assert.equal(DEFAULT_PI_DAEMON_WEB_CONFIG.enabled, true);
  assert.equal(DEFAULT_PI_DAEMON_WEB_CONFIG.port, 7464);
  assert.equal(DEFAULT_PI_DAEMON_WEB_CONFIG.tui.defaultPresentation, "rich");
  assert.equal(DEFAULT_PI_DAEMON_WEB_CONFIG.inventory.maxSessions, 10_000);
});

test("missing implicit instance config preserves CLI compatibility", async (t) => {
  const root = await fixture(t);
  const loaded = await loadPiDaemonConfig({
    homeDirectory: root,
    xdgConfigHome: join(root, "config-home"),
    environment: {},
  });
  assert.equal(loaded.instance, "default");
  assert.equal(loaded.present, false);
  assert.equal(loaded.explicitPath, false);
  assert.deepEqual(loaded.config, {});
  assert.equal(
    loaded.path,
    join(root, "config-home", "pi", "daemon", "default", "config.yaml"),
  );
});

test("loads strict bounded instance YAML and resolves paths relative to it", async (t) => {
  const root = await fixture(t);
  const path = await writeConfig(
    root,
    `instance: work
stateDir: ./state
socketPath: ./run/daemon.sock
agentDir: ~/agent
allowedRoots: [./repo, ~/shared]
sessionStorage:
  mode: pi-session-root
security:
  allowAuthorityRootOverlap: true
limits:
  maxSessions: 32
  idleSessionTtlMs: 0
api:
  enabled: true
  bind: 127.0.0.1
  port: 7463
  tokenFile: ./api-token
web:
  enabled: true
  mode: embedded
  port: 7464
  publicOrigin: https://dash.example.test
  allowInsecureHttp: false
  tls:
    certFile: ./dash-cert.pem
    keyFile: ./dash-key.pem
    reloadIntervalMs: 30000
  proxy:
    trustForwardedHeaders: true
  auth:
    tokenFile: ./web-token
    sessionTtlMs: 60000
  inventory:
    roots: [./extra-sessions]
    reconcileIntervalMs: 30000
    maxSessions: 10000
  residency:
    warmTtlMs: 1800000
    maxPinnedPerWorkspace: 8
  tui:
    enabled: true
    defaultPresentation: rich
    maxRows: 200
    maxColumns: 320
  runtimePolicy:
    model:
      provider: github-copilot
      id: gpt-5.6-sol
      thinkingLevel: high
    tools:
      mode: allowlist
      include: [self_set_model]
    resources:
      extensions: ["/opt/pi-extensions/agent-utils/m.js"]
      projectTrust: approve
      noContextFiles: true
      inheritInstalledPackages: true
    settings:
      agentUtils: { modelShortcut: true }
  ui:
    editor: { mode: vim }
    theme: { name: nord-midnight }
`,
  );
  const loaded = await loadPiDaemonConfig({
    cliConfigPath: path,
    cliInstance: "work",
    homeDirectory: root,
    environment: {},
  });
  assert.equal(loaded.present, true);
  assert.equal(loaded.config.limits.maxSessions, 32);
  assert.equal(loaded.config.security.allowAuthorityRootOverlap, true);
  assert.equal(loaded.config.web.tui.defaultPresentation, "rich");
  assert.equal(loaded.config.web.publicOrigin, "https://dash.example.test");
  assert.equal(loaded.config.web.allowInsecureHttp, false);
  assert.deepEqual(loaded.config.web.tls, {
    certFile: "./dash-cert.pem",
    keyFile: "./dash-key.pem",
    reloadIntervalMs: 30000,
  });
  assert.deepEqual(loaded.config.web.proxy, { trustForwardedHeaders: true });
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.config.web.runtimePolicy)), {
    model: {
      provider: "github-copilot",
      id: "gpt-5.6-sol",
      thinkingLevel: "high",
    },
    tools: { mode: "allowlist", include: ["self_set_model"] },
    resources: {
      extensions: ["/opt/pi-extensions/agent-utils/m.js"],
      projectTrust: "approve",
      noContextFiles: true,
      inheritInstalledPackages: true,
    },
    settings: { agentUtils: { modelShortcut: true } },
  });
  assert.equal(loaded.resolvePath(loaded.config.stateDir), join(root, "state"));
  assert.equal(loaded.resolvePath(loaded.config.agentDir), join(root, "agent"));
  assert.deepEqual(
    loaded.config.allowedRoots.map((entry) => loaded.resolvePath(entry)),
    [join(root, "repo"), join(root, "shared")],
  );
});

test("strict YAML accepts only identity metadata and credential sources", async (t) => {
  const root = await fixture(t);
  const path = await writeConfig(root, `instance: work
web:
  auth:
    sessionTtlMs: 60000
    identityProvider:
      type: static
      identities:
        - identityId: owner
          globalRole: administrator
          displayName: Dashboard owner
          credentialFile: ./owner.secret
        - identityId: reader
          globalRole: member
          credentialFd: 9
`);
  const loaded = await loadPiDaemonConfig({
    cliConfigPath: path,
    cliInstance: "work",
    homeDirectory: root,
    environment: {},
  });
  assert.deepEqual(loaded.config.web.auth.identityProvider, {
    type: "static",
    identities: [
      {
        identityId: "owner",
        globalRole: "administrator",
        displayName: "Dashboard owner",
        credentialFile: "./owner.secret",
      },
      { identityId: "reader", globalRole: "member", credentialFd: 9 },
    ],
  });
  assert.doesNotMatch(JSON.stringify(loaded.config), /credential\s*:/i);
});

test("CLI config and instance selection override environment selection", async (t) => {
  const root = await fixture(t);
  const selected = await writeConfig(root, "instance: cli\n");
  const ignored = join(root, "ignored.yaml");
  await writeFile(ignored, "instance: env\n", { mode: 0o600 });
  const loaded = await loadPiDaemonConfig({
    cliConfigPath: selected,
    cliInstance: "cli",
    environment: {
      [PI_DAEMON_CONFIG_ENV]: ignored,
      [PI_DAEMON_INSTANCE_ENV]: "env",
    },
    homeDirectory: root,
  });
  assert.equal(loaded.instance, "cli");
  assert.equal(loaded.path, selected);
});

test("rejects missing explicit, mismatched, duplicate, aliased, unknown, secret and insecure config", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    loadPiDaemonConfig({ cliConfigPath: join(root, "missing.yaml"), environment: {} }),
    (error) => error instanceof PiDaemonConfigError && error.code === "config_not_found",
  );

  const cases = [
    ["mismatch", "instance: other\n", "config_instance_mismatch"],
    ["duplicate", "instance: work\ninstance: work\n", "config_invalid_yaml"],
    ["alias", "web: &w { enabled: true }\ncopy: *w\n", "config_invalid_yaml"],
    ["unknown", "mystery: true\n", "config_unknown_field"],
    ["secret", "web:\n  ui:\n    password: do-not-store\n", "config_secret_value_forbidden"],
    ["bad-port", "api:\n  enabled: true\n  port: 70000\n", "config_invalid"],
    ["runtime-unknown", "web:\n  runtimePolicy:\n    env: { OPENAI_API_KEY: forbidden }\n", "config_unknown_field"],
    ["runtime-secret", "web:\n  runtimePolicy:\n    settings:\n      apiKey: forbidden\n", "config_secret_value_forbidden"],
    ["runtime-relative-extension", "web:\n  runtimePolicy:\n    resources:\n      extensions: [./ambient.mjs]\n", "config_invalid"],
    ["runtime-settings-packages", "web:\n  runtimePolicy:\n    resources: { projectTrust: approve }\n    settings:\n      packages: [npm:ambient]\n", "config_invalid"],
    ["tls-fd", "web:\n  tls:\n    certFd: 2\n    keyFd: 4\n", "config_invalid"],
    ["tls-reload", "web:\n  tls:\n    reloadIntervalMs: 999\n", "config_invalid"],
    ["proxy-unknown", "web:\n  proxy:\n    trustAll: true\n", "config_unknown_field"],
    ["identity-literal", "web:\n  auth:\n    identityProvider:\n      type: static\n      identities:\n        - identityId: owner\n          globalRole: administrator\n          credential: forbidden\n", "config_unknown_field"],
    ["identity-source", "web:\n  auth:\n    identityProvider:\n      type: static\n      identities:\n        - identityId: owner\n          globalRole: administrator\n          credentialFile: ./one\n          credentialFd: 9\n", "config_invalid"],
    ["identity-admin", "web:\n  auth:\n    identityProvider:\n      type: static\n      identities:\n        - identityId: member\n          globalRole: member\n          credentialFile: ./one\n", "config_invalid"],
    ["identity-mutually-exclusive", "web:\n  auth:\n    tokenFile: ./legacy\n    identityProviderFile: ./identities.yaml\n", "config_invalid"],
  ];
  for (const [name, text, code] of cases) {
    const directory = join(root, name);
    await mkdir(directory);
    const path = await writeConfig(directory, text);
    await assert.rejects(
      loadPiDaemonConfig({ cliConfigPath: path, cliInstance: "work", environment: {} }),
      (error) => error instanceof PiDaemonConfigError && error.code === code,
      name,
    );
  }

  const insecureDirectory = join(root, "insecure");
  await mkdir(insecureDirectory);
  const insecure = await writeConfig(insecureDirectory, "instance: work\n", 0o666);
  await chmod(insecure, 0o666);
  await assert.rejects(
    loadPiDaemonConfig({ cliConfigPath: insecure, cliInstance: "work", environment: {} }),
    (error) => error instanceof PiDaemonConfigError && error.code === "config_insecure_mode",
  );
});

test("serve consumes YAML while individual CLI flags override configured values", async (t) => {
  const root = await fixture(t);
  await Promise.all([
    mkdir(join(root, "work"), { mode: 0o700 }),
    mkdir(join(root, "config"), { mode: 0o700 }),
  ]);
  await writeFile(join(root, "config", "auth.json"), "{}\n", { mode: 0o600 });
  const path = await writeConfig(
    join(root, "config"),
    `instance: test
stateDir: ../state
socketPath: ../daemon.sock
agentDir: ../agent
authSeedFile: ./auth.json
allowedRoots: [../work]
limits:
  maxSessions: 9
  maxConcurrentTurns: 2
  maxConnections: 3
  maxLineBytes: 4096
api:
  enabled: true
  port: 0
`,
  );
  const logs = [];
  const code = await runCli(
    [
      "serve",
      "--config",
      path,
      "--instance",
      "test",
      "--max-sessions",
      "7",
      "--api-enabled",
      "false",
    ],
    { stdout: () => {}, stderr: (text) => logs.push(text) },
    {
      factory: new EmptyFactory(),
      waitForShutdown: async (shutdown) => {
        const client = await PiDaemonClient.connect({ socketPath: join(root, "daemon.sock") });
        try {
          const handshake = await client.handshake("config-handshake");
          assert.equal(handshake.data.limits.multiplexer.maxSessions, 7);
          assert.equal(handshake.data.limits.multiplexer.maxConcurrentTurns, 2);
          assert.equal(handshake.data.limits.maxConnections, 3);
          assert.equal(handshake.data.limits.maxLineBytes, 4096);
        } finally {
          client.close();
        }
        const ready = logs.map((line) => JSON.parse(line)).find((entry) => entry.event === "pi_daemon_ready");
        assert.equal(ready.api.enabled, false);
        assert.deepEqual(ready.configuration, {
          instance: "test",
          fileLoaded: true,
          webConfigured: false,
        });
        await shutdown();
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(logs.join("").includes(root), false);
});
