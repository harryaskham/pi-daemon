import assert from "node:assert/strict";
import { chmod, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SERVICE_BEARER_ENV,
  ServiceBearerAuthenticator,
  loadServiceBearer,
} from "../dist/api-auth.js";

const TOKEN = "fixture-service-bearer-0123456789";

test("service bearer authentication is exact and stores no printable token surface", () => {
  const auth = new ServiceBearerAuthenticator(TOKEN);
  assert.equal(auth.authenticate(`Bearer ${TOKEN}`), true);
  assert.equal(auth.authenticate(`bearer ${TOKEN}`), false);
  assert.equal(auth.authenticate(`Bearer ${TOKEN}x`), false);
  assert.equal(auth.authenticate(`Bearer ${TOKEN.slice(0, 15)}`), false);
  assert.equal(auth.authenticate(undefined), false);
  assert.equal(JSON.stringify(auth).includes(TOKEN), false);
});

test("bearer source is singular and environment values never appear in errors", () => {
  const loaded = loadServiceBearer({ environment: { [SERVICE_BEARER_ENV]: TOKEN } });
  assert.equal(loaded.source, "environment");
  assert.equal(loaded.authenticator.authenticate(`Bearer ${TOKEN}`), true);

  assert.throws(
    () => loadServiceBearer({ environment: {} }),
    (error) => error instanceof Error && !error.message.includes(TOKEN),
  );
  assert.throws(
    () =>
      loadServiceBearer({
        tokenFile: "/not-read-because-conflicting",
        environment: { [SERVICE_BEARER_ENV]: TOKEN },
      }),
    /mutually exclusive/,
  );
});

test("owner-only regular token files and inherited descriptors load safely", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-daemon-api-auth-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, "token");
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });

  const fromFile = loadServiceBearer({ tokenFile, environment: {} });
  assert.equal(fromFile.source, "file");
  assert.equal(fromFile.authenticator.authenticate(`Bearer ${TOKEN}`), true);

  const handle = await open(tokenFile, "r");
  t.after(async () => handle.close());
  const fromFd = loadServiceBearer({ tokenFd: handle.fd, environment: {} });
  assert.equal(fromFd.source, "fd");
  assert.equal(fromFd.authenticator.authenticate(`Bearer ${TOKEN}`), true);

  await chmod(tokenFile, 0o644);
  assert.throws(() => loadServiceBearer({ tokenFile, environment: {} }), /owner-only/);
  await chmod(tokenFile, 0o600);
  const tokenLink = join(directory, "token-link");
  await symlink(tokenFile, tokenLink);
  assert.throws(() => loadServiceBearer({ tokenFile: tokenLink, environment: {} }), /non-symlink/);
});

test("bearer values are bounded and safe for Authorization headers", () => {
  for (const invalid of ["short", "contains whitespace 123456", "line\nbreak-123456789"] ) {
    assert.throws(() => new ServiceBearerAuthenticator(invalid));
  }
});
