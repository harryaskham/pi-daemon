import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ROOT_UID,
  hasForeignPathOwner,
  isPermittedPathOwner,
} from "../dist/path-ownership.js";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

/**
 * Ownership guards per module, by the policy each guard applies.
 *
 * The split is deliberate. `ownerOrRoot` covers material the system provisions
 * for the service — configuration, TLS material, installed package resources,
 * session defaults — where a root-owned Nix store path or system file is a
 * normal deployment. `ownerOnly` covers material the service holds as its own
 * secret — the bearer token, the Pi auth seed, dashboard credentials, the
 * authorization store, durable session state — where root ownership is not a
 * deployment shape but evidence that something else wrote it.
 *
 * Two modules are mixed because they touch both kinds: `pi-adapter.ts` accepts
 * a root-owned agent directory and package resources while requiring the auth
 * storage and session files be owner-only, and `schedule-config.ts` does the
 * same for its configuration against its persisted state.
 *
 * This census exists because none of these guards is reachable end to end: every
 * fixture is created by the process that then loads it, so `info.uid` equals
 * `getuid()` by construction and no test can make one fire. Pinning the counts
 * makes a new guard declare itself and makes a policy flip — a secret path
 * quietly gaining `|| info.uid === 0` — a visible diff rather than a silent
 * widening.
 */
const OWNERSHIP_CENSUS = {
  "api-auth.ts": { ownerOnly: 1, ownerOrRoot: 0 },
  "bootstrap.ts": { ownerOnly: 1, ownerOrRoot: 0 },
  "config.ts": { ownerOnly: 0, ownerOrRoot: 1 },
  "dashboard-auth.ts": { ownerOnly: 3, ownerOrRoot: 0 },
  "dashboard-authorization.ts": { ownerOnly: 2, ownerOrRoot: 0 },
  "dashboard-identity-config.ts": { ownerOnly: 0, ownerOrRoot: 1 },
  "dashboard-server.ts": { ownerOnly: 0, ownerOrRoot: 1 },
  "dashboard-session-defaults.ts": { ownerOnly: 0, ownerOrRoot: 1 },
  "dashboard-store.ts": { ownerOnly: 2, ownerOrRoot: 0 },
  "dashboard-tls.ts": { ownerOnly: 0, ownerOrRoot: 1 },
  "durability.ts": { ownerOnly: 3, ownerOrRoot: 0 },
  "installed-package-resources.ts": { ownerOnly: 0, ownerOrRoot: 2 },
  "pi-adapter.ts": { ownerOnly: 3, ownerOrRoot: 2 },
  "rpc-stdio-cli.ts": { ownerOnly: 1, ownerOrRoot: 0 },
  "schedule-config.ts": { ownerOnly: 1, ownerOrRoot: 1 },
  "self-update.ts": { ownerOnly: 2, ownerOrRoot: 0 },
  "server.ts": { ownerOnly: 2, ownerOrRoot: 0 },
  "session-cli.ts": { ownerOnly: 2, ownerOrRoot: 0 },
  "session-inventory.ts": { ownerOnly: 5, ownerOrRoot: 0 },
  "session-ownership.ts": { ownerOnly: 3, ownerOrRoot: 0 },
  "tool-adapter-runtime.ts": { ownerOnly: 1, ownerOrRoot: 0 },
  "transcript-projector.ts": { ownerOnly: 1, ownerOrRoot: 0 },
};

/** Classify each ownership comparison in a module by the policy it applies. */
function censusOf(source) {
  const lines = source.split("\n");
  let ownerOnly = 0;
  let ownerOrRoot = 0;
  lines.forEach((line, index) => {
    if (!line.includes(".uid !== ")) return;
    const isCurrentUserComparison =
      line.includes(".uid !== getuid()") || line.includes(".uid !== process.getuid()");
    if (!isCurrentUserComparison) return;
    // The root exemption is written on the same line or the next two.
    const window = lines.slice(index, index + 3).join(" ");
    if (/\.uid !== 0\b/.test(window)) ownerOrRoot += 1;
    else ownerOnly += 1;
  });
  return { ownerOnly, ownerOrRoot };
}

test("the ownership predicate rejects every owner it must", () => {
  const currentUid = 1000;
  const foreignUid = 1001;

  // owner-only: nobody but the current user, root included.
  assert.equal(isPermittedPathOwner(currentUid, "owner-only", currentUid), true);
  assert.equal(isPermittedPathOwner(foreignUid, "owner-only", currentUid), false);
  assert.equal(isPermittedPathOwner(ROOT_UID, "owner-only", currentUid), false);

  // owner-or-root: the current user or root, nobody else.
  assert.equal(isPermittedPathOwner(currentUid, "owner-or-root", currentUid), true);
  assert.equal(isPermittedPathOwner(ROOT_UID, "owner-or-root", currentUid), true);
  assert.equal(isPermittedPathOwner(foreignUid, "owner-or-root", currentUid), false);

  // A process running as root owns root-owned paths under either policy.
  assert.equal(isPermittedPathOwner(ROOT_UID, "owner-only", ROOT_UID), true);
  assert.equal(isPermittedPathOwner(foreignUid, "owner-only", ROOT_UID), false);

  // Platforms without uids cannot answer the question; every call site already
  // skipped the check there rather than failing closed on a missing quantity.
  assert.equal(isPermittedPathOwner(foreignUid, "owner-only", undefined), true);
});

test("the guard shape used at the call sites matches the predicate", () => {
  const currentUid = 1000;
  for (const policy of ["owner-only", "owner-or-root"]) {
    for (const ownerUid of [currentUid, ROOT_UID, 1001]) {
      assert.equal(
        hasForeignPathOwner(ownerUid, policy, currentUid),
        !isPermittedPathOwner(ownerUid, policy, currentUid),
        `${policy} guard disagreed with the predicate for uid ${ownerUid}`,
      );
    }
  }
  assert.equal(hasForeignPathOwner(1001, "owner-only", undefined), false);
  // The predicate takes the uid explicitly: an earlier draft defaulted it to
  // process.getuid?.(), which turned an explicit "this platform has no uid"
  // into "use the real one" and inverted this case.
  assert.equal(hasForeignPathOwner.length, 3, "currentUid must stay required");
});

test("every ownership guard in the source is accounted for by policy", async () => {
  const entries = (await readdir(sourceRoot)).filter((name) => name.endsWith(".ts")).sort();
  const observed = {};
  for (const entry of entries) {
    const census = censusOf(await readFile(join(sourceRoot, entry), "utf8"));
    if (census.ownerOnly > 0 || census.ownerOrRoot > 0) observed[entry] = census;
  }

  assert.deepEqual(
    observed,
    OWNERSHIP_CENSUS,
    "an ownership guard was added, removed, or changed policy: update the census and say why in the commit. " +
      "A secret path gaining a root exemption is a widening, not a refactor.",
  );

  const totals = Object.values(observed).reduce(
    (sum, { ownerOnly, ownerOrRoot }) => ({
      ownerOnly: sum.ownerOnly + ownerOnly,
      ownerOrRoot: sum.ownerOrRoot + ownerOrRoot,
    }),
    { ownerOnly: 0, ownerOrRoot: 0 },
  );
  assert.equal(totals.ownerOnly, 33);
  assert.equal(totals.ownerOrRoot, 10);
});

test("the census classifier itself distinguishes the two policies", () => {
  // Negative control: the classifier is what makes the census meaningful, so it
  // is checked against both shapes rather than trusted.
  assert.deepEqual(
    censusOf("if (getuid !== undefined && info.uid !== getuid()) throw new Error('x');"),
    { ownerOnly: 1, ownerOrRoot: 0 },
  );
  assert.deepEqual(
    censusOf("if (getuid !== undefined && info.uid !== getuid() && info.uid !== 0) throw x;"),
    { ownerOnly: 0, ownerOrRoot: 1 },
  );
  assert.deepEqual(
    censusOf(
      ["if (", "  getuid !== undefined &&", "  info.uid !== getuid() &&", "  info.uid !== 0", ") throw x;"].join(
        "\n",
      ),
    ),
    { ownerOnly: 0, ownerOrRoot: 1 },
    "a guard split across lines must still be seen as accepting root",
  );
  assert.deepEqual(censusOf("const other = info.uid !== previous.uid;"), {
    ownerOnly: 0,
    ownerOrRoot: 0,
  });
});
