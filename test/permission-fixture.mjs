import { chmod, mkdir, stat, writeFile } from "node:fs/promises";

/**
 * Fixtures whose permissions are the point of the test.
 *
 * `writeFile`'s and `mkdir`'s `mode` options are masked by the ambient umask,
 * and `mkdir` does not apply a mode at all to a directory that already exists.
 * A case that creates a deliberately permissive file to prove it is rejected
 * therefore creates an owner-only one on a hardened runner, and its fail-closed
 * assertion passes with nothing to reject.
 *
 * These helpers set the mode explicitly and then assert it, so the precondition
 * the assertion depends on is itself checked. When the environment will not
 * allow the mode, the fixture fails loudly rather than the test passing
 * vacuously. See CONTRIBUTING, "Negative controls", where this is the first-preference form.
 */
export async function assertFixtureMode(path, expected, what = "fixture path") {
  const actual = (await stat(path)).mode & 0o7777;
  if (actual === expected) return;
  throw new Error(
    `${what} ${path} should be mode ${expected.toString(8)} but is ${actual.toString(8)}. ` +
      "This fixture's permissions are the property under test, so the case cannot run " +
      "without them; check the ambient umask and the filesystem's mode support.",
  );
}

/** Write a file whose mode the surrounding assertion depends on. */
export async function writeFileWithMode(path, contents, mode) {
  await writeFile(path, contents, { mode });
  await chmod(path, mode);
  await assertFixtureMode(path, mode, "fixture file");
  return path;
}

/** Create a directory whose mode the surrounding assertion depends on. */
export async function mkdirWithMode(path, mode) {
  await mkdir(path, { recursive: true, mode });
  await chmod(path, mode);
  await assertFixtureMode(path, mode, "fixture directory");
  return path;
}
