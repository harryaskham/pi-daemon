import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  EXPOSURE_FORBIDDEN_BITS,
  hasForbiddenExposure,
  isTrustedPath,
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
  // bd-5fbf37 moved these exact five owner-only decisions without changing
  // policy: two persisted index/head checks and three root/source scan checks.
  "session-inventory-persistence.ts": { ownerOnly: 2, ownerOrRoot: 0 },
  "session-inventory-scanner.ts": { ownerOnly: 3, ownerOrRoot: 0 },
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

/**
 * Mode-mask literals per module, by the exposure policy each expresses.
 *
 * The second axis, censused separately from ownership because it is a separate
 * decision. Correlating the two holds for 31 of 44 sites and breaks for 9,
 * which pair a strict owner with a lax mask for session state: only the current
 * user may have written it, but others reading it is not the property being
 * protected. Deriving the mask from the ownership policy would have tightened
 * those nine silently.
 *
 * Counted as raw literals rather than by proximity to a guard. An earlier audit
 * of the ownership half used a three-line window and could misread a distant
 * exemption, then match that misreading against itself; counting literals has
 * no window to get wrong.
 */
const EXPOSURE_CENSUS = {
  "api-auth.ts": { private: 1, noForeignWriters: 0 },
  "bootstrap.ts": { private: 1, noForeignWriters: 0 },
  "config.ts": { private: 0, noForeignWriters: 1 },
  "dashboard-auth.ts": { private: 3, noForeignWriters: 0 },
  "dashboard-authorization.ts": { private: 2, noForeignWriters: 0 },
  "dashboard-identity-config.ts": { private: 0, noForeignWriters: 1 },
  "dashboard-server.ts": { private: 0, noForeignWriters: 1 },
  "dashboard-session-defaults.ts": { private: 0, noForeignWriters: 1 },
  "dashboard-store.ts": { private: 2, noForeignWriters: 0 },
  "dashboard-tls.ts": { private: 1, noForeignWriters: 1 },
  "durability.ts": { private: 3, noForeignWriters: 0 },
  "installed-package-resources.ts": { private: 0, noForeignWriters: 2 },
  "pi-adapter.ts": { private: 1, noForeignWriters: 4 },
  "rpc-stdio-cli.ts": { private: 1, noForeignWriters: 0 },
  "schedule-config.ts": { private: 1, noForeignWriters: 1 },
  "self-update.ts": { private: 1, noForeignWriters: 1 },
  "server.ts": { private: 0, noForeignWriters: 1 },
  "session-cli.ts": { private: 2, noForeignWriters: 0 },
  // Same three exposure decisions, relocated by bd-5fbf37: the two owner-only
  // persisted files stay private; the approved session root keeps permitting
  // foreign reads while forbidding foreign writers.
  "session-inventory-persistence.ts": { private: 2, noForeignWriters: 0 },
  "session-inventory-scanner.ts": { private: 0, noForeignWriters: 1 },
  "session-ownership.ts": { private: 0, noForeignWriters: 3 },
  "tool-adapter-runtime.ts": { private: 2, noForeignWriters: 0 },
  "transcript-projector.ts": { private: 0, noForeignWriters: 1 },
};

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

test("the exposure predicate forbids exactly the bits its policy names", () => {
  // The named policies and the octal literals the census counts must stay tied
  // together, or the census would be counting something the predicate no longer
  // means.
  assert.deepEqual(EXPOSURE_FORBIDDEN_BITS, { private: 0o077, "no-foreign-writers": 0o022 });
  assert.throws(() => {
    EXPOSURE_FORBIDDEN_BITS.private = 0o022;
  }, "the mask table must be frozen: a widened bit set would silently pass every guard");

  // 0o077: nobody but the owner. 0o022: others may read, nobody else may write.
  assert.equal(hasForbiddenExposure(0o600, "private"), false);
  assert.equal(hasForbiddenExposure(0o640, "private"), true);
  assert.equal(hasForbiddenExposure(0o604, "private"), true);
  assert.equal(hasForbiddenExposure(0o700, "private"), false);

  assert.equal(hasForbiddenExposure(0o644, "no-foreign-writers"), false);
  assert.equal(hasForbiddenExposure(0o755, "no-foreign-writers"), false);
  assert.equal(hasForbiddenExposure(0o664, "no-foreign-writers"), true);
  assert.equal(hasForbiddenExposure(0o646, "no-foreign-writers"), true);

  // The policies are not orderings of one another: a mode may satisfy the
  // laxer one and fail the stricter, which is the whole reason they are two.
  assert.equal(hasForbiddenExposure(0o644, "private"), true);
  assert.equal(hasForbiddenExposure(0o644, "no-foreign-writers"), false);
});

test("a path is trusted only when both axes agree, and exposure is optional", () => {
  const currentUid = 1000;
  const secret = { owner: "owner-only", exposure: "private" };
  assert.equal(isTrustedPath({ uid: currentUid, mode: 0o600 }, secret, currentUid), true);
  assert.equal(isTrustedPath({ uid: currentUid, mode: 0o640 }, secret, currentUid), false);
  assert.equal(isTrustedPath({ uid: 0, mode: 0o600 }, secret, currentUid), false);

  const provisioned = { owner: "owner-or-root", exposure: "no-foreign-writers" };
  assert.equal(isTrustedPath({ uid: 0, mode: 0o644 }, provisioned, currentUid), true);
  assert.equal(isTrustedPath({ uid: 0, mode: 0o664 }, provisioned, currentUid), false);
  assert.equal(isTrustedPath({ uid: 1001, mode: 0o644 }, provisioned, currentUid), false);

  // Authority-to-act checks — refusing to replace a socket the process does not
  // own, skipping foreign entries in a scan — decide who may act on a path, not
  // what may be trusted from its contents. A mode requirement would be wrong
  // there rather than merely redundant, so the policy omits it.
  const authority = { owner: "owner-only" };
  assert.equal(isTrustedPath({ uid: currentUid, mode: 0o666 }, authority, currentUid), true);
  assert.equal(isTrustedPath({ uid: 1001, mode: 0o600 }, authority, currentUid), false);
});

test("every mode mask in the source is accounted for by exposure policy", async () => {
  const entries = (await readdir(sourceRoot)).filter((name) => name.endsWith(".ts")).sort();
  const observed = {};
  for (const entry of entries) {
    if (entry === "path-ownership.ts") continue;
    const source = await readFile(join(sourceRoot, entry), "utf8");
    // Both shapes, for the same reason the ownership census counts both: an
    // adopted call names its policy, and a raw mask written the old way must
    // still be counted or it evades the census by being what the census exists
    // to notice.
    const named = [...source.matchAll(/"(private|no-foreign-writers)"/g)].map((m) => m[1]);
    const private_ =
      named.filter((policy) => policy === "private").length + (source.match(/0o077/g) ?? []).length;
    const noForeignWriters =
      named.filter((policy) => policy === "no-foreign-writers").length +
      (source.match(/0o022/g) ?? []).length;
    if (private_ > 0 || noForeignWriters > 0) observed[entry] = { private: private_, noForeignWriters };
  }
  assert.deepEqual(
    observed,
    EXPOSURE_CENSUS,
    "an exposure decision was added, removed, or changed: update the census and say why. " +
      "Since adoption most sites name their policy rather than writing a mask, so the change that " +
      "fires this is usually a \"private\" becoming \"no-foreign-writers\" (or the reverse), not an " +
      "octal literal — chasing 0o077 in the diff will find nothing. Either direction is a change of " +
      "policy: widening exposes material the site was protecting, narrowing breaks session state " +
      "that is deliberately readable.",
  );
});

test("no exposure decision is computed outside the tested predicate", async () => {
  // The mode counterpart of the ownership invariant. A raw mask is a decision
  // no test covers, and the census counts it precisely so this can name it.
  const entries = (await readdir(sourceRoot)).filter((name) => name.endsWith(".ts")).sort();
  const openCoded = [];
  for (const entry of entries) {
    if (entry === "path-ownership.ts") continue;
    const source = await readFile(join(sourceRoot, entry), "utf8");
    source.split("\n").forEach((line, index) => {
      if (/0o077|0o022/.test(line)) openCoded.push(`${entry}:${index + 1} ${line.trim()}`);
    });
  }
  assert.deepEqual(
    openCoded,
    [],
    "these mask modes themselves instead of calling hasForbiddenExposure",
  );
});
