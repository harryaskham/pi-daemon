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
  "tool-adapter-runtime.ts": { ownerOnly: 2, ownerOrRoot: 0 },
  "transcript-projector.ts": { ownerOnly: 1, ownerOrRoot: 0 },
};

/**
 * Classify each ownership decision in a module by the policy it applies.
 *
 * Both shapes are recognised. The adopted shape is a `hasForeignPathOwner` call
 * naming its policy; the open-coded shape is the uid comparison the call sites
 * used before adoption. The second is retained deliberately: a new guard
 * written the old way must still be counted, or it would evade the census by
 * being the very thing the census exists to notice.
 */
function censusOf(source) {
  const lines = source.split("\n");
  let ownerOnly = 0;
  let ownerOrRoot = 0;

  for (const match of source.matchAll(
    /hasForeignPathOwner\([^,]+,\s*"(owner-only|owner-or-root)"/g,
  )) {
    if (match[1] === "owner-or-root") ownerOrRoot += 1;
    else ownerOnly += 1;
  }

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
  // 34 rather than 33: adoption split the socket/parent pair in
  // tool-adapter-runtime.ts into two decisions, which it always was.
  assert.equal(totals.ownerOnly, 34);
  assert.equal(totals.ownerOrRoot, 10);
});

test("no ownership decision is computed outside the tested predicate", async () => {
  // The predicate is only authoritative if nothing recomputes the decision. An
  // open-coded comparison is a guard no test can reach, which is the situation
  // the extraction replaced; the census would count it, but counting it is not
  // the same as covering it.
  const entries = (await readdir(sourceRoot)).filter((name) => name.endsWith(".ts")).sort();
  const openCoded = [];
  for (const entry of entries) {
    if (entry === "path-ownership.ts") continue;
    const source = await readFile(join(sourceRoot, entry), "utf8");
    source.split("\n").forEach((line, index) => {
      if (line.includes(".uid !== ")) openCoded.push(`${entry}:${index + 1} ${line.trim()}`);
    });
  }
  assert.deepEqual(
    openCoded,
    [],
    "these decide ownership themselves instead of calling hasForeignPathOwner",
  );
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
  // And the adopted shape, which is what the call sites carry now.
  assert.deepEqual(
    censusOf('if (hasForeignPathOwner(info.uid, "owner-only", getuid?.())) throw x;'),
    { ownerOnly: 1, ownerOrRoot: 0 },
  );
  assert.deepEqual(
    censusOf('if (hasForeignPathOwner(info.uid, "owner-or-root", getuid?.())) throw x;'),
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
