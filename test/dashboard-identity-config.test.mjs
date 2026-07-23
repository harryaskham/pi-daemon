import assert from "node:assert/strict";
import { fstatSync } from "node:fs";
import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiDaemonConfigError } from "../dist/config.js";
import {
  createDashboardIdentityProvider,
  loadDashboardIdentityProviderFile,
} from "../dist/dashboard-identity-config.js";

const OWNER_TOKEN = "owner-identity-token-0123456789abcdef";
const MEMBER_TOKEN = "member-identity-token-0123456789abcdef";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-identity-config-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

async function secret(path, value) {
  await writeFile(path, `${value}\n`, { mode: 0o600 });
}

test("inline static provider resolves owner-only files without retaining source bytes", async (t) => {
  const root = await fixture(t);
  await Promise.all([
    secret(join(root, "owner.secret"), OWNER_TOKEN),
    secret(join(root, "member.secret"), MEMBER_TOKEN),
  ]);
  const config = {
    type: "static",
    identities: [
      { identityId: "owner", globalRole: "administrator", displayName: "Owner", credentialFile: "owner.secret" },
      { identityId: "member", globalRole: "member", credentialFile: "member.secret" },
    ],
  };
  const provider = await createDashboardIdentityProvider(config, (path) => join(root, path));
  assert.deepEqual(provider.authenticate(OWNER_TOKEN), {
    identityId: "owner",
    globalRole: "administrator",
    displayName: "Owner",
  });
  assert.deepEqual(provider.authenticate(MEMBER_TOKEN), {
    identityId: "member",
    globalRole: "member",
  });
  assert.equal(provider.authenticate("wrong-identity-token-0123456789"), undefined);
  assert.doesNotMatch(JSON.stringify(config), new RegExp(`${OWNER_TOKEN}|${MEMBER_TOKEN}`));
});

test("strict provider YAML supports relative files and inherited descriptors", async (t) => {
  const root = await fixture(t);
  await secret(join(root, "owner.secret"), OWNER_TOKEN);
  const memberPath = join(root, "member.secret");
  await secret(memberPath, MEMBER_TOKEN);
  const memberHandle = await open(memberPath, "r");
  t.after(async () => memberHandle.close().catch(() => undefined));
  const providerPath = join(root, "identities.yaml");
  await writeFile(providerPath, `type: static
identities:
  - identityId: owner
    globalRole: administrator
    credentialFile: ./owner.secret
  - identityId: member
    globalRole: member
    displayName: Shared member
    credentialFd: ${memberHandle.fd}
`, { mode: 0o644 });
  const provider = await loadDashboardIdentityProviderFile(providerPath);
  assert.equal(provider.authenticate(OWNER_TOKEN)?.identityId, "owner");
  assert.equal(provider.authenticate(MEMBER_TOKEN)?.displayName, "Shared member");
  assert.throws(() => fstatSync(memberHandle.fd), { code: "EBADF" });
  assert.doesNotMatch(await (await import("node:fs/promises")).readFile(providerPath, "utf8"), /token-012345/);
});

test("provider documents and credential sources fail closed", async (t) => {
  const root = await fixture(t);
  const insecure = join(root, "insecure.yaml");
  await writeFile(insecure, "type: static\nidentities: []\n", { mode: 0o666 });
  await chmod(insecure, 0o666);
  await assert.rejects(
    loadDashboardIdentityProviderFile(insecure),
    (error) => error instanceof PiDaemonConfigError && error.code === "identity_provider_insecure_mode",
  );

  const literal = join(root, "literal.yaml");
  await writeFile(literal, `type: static
identities:
  - identityId: owner
    globalRole: administrator
    credential: ${OWNER_TOKEN}
`, { mode: 0o600 });
  await assert.rejects(
    loadDashboardIdentityProviderFile(literal),
    (error) => error instanceof PiDaemonConfigError && error.code === "config_unknown_field",
  );

  const secretPath = join(root, "owner.secret");
  await writeFile(secretPath, `${OWNER_TOKEN}\n`, { mode: 0o644 });
  const providerPath = join(root, "provider.yaml");
  await writeFile(providerPath, `type: static
identities:
  - identityId: owner
    globalRole: administrator
    credentialFile: ./owner.secret
`, { mode: 0o600 });
  await assert.rejects(
    loadDashboardIdentityProviderFile(providerPath),
    /dashboard credential file must be owner-only/,
  );
});
