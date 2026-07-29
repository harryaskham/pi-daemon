import { execFile } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The TLS cases need a real certificate/key pair. `node:crypto` cannot issue an
// X.509 certificate — `X509Certificate` is parse-only — so this shells out.
// That makes `openssl` a genuine dependency of the test suite rather than an
// incidental convenience, and `OPENSSL_BIN` lets a lane point at a specific one.
const OPENSSL_BIN = process.env.OPENSSL_BIN ?? "openssl";

function missingOpensslError(cause) {
  return new Error(
    `the TLS fixture needs an \`openssl\` binary and could not run \`${OPENSSL_BIN}\`. ` +
      "It is a declared dependency of this suite, not an optional extra: these cases cover " +
      "TLS material loading, native HTTPS authority, and credential fail-closed behaviour, " +
      "so they must not be skipped when it is absent. The Nix lanes provide it (flake.nix " +
      "lists pkgs.openssl); on a plain Node lane, install openssl or set OPENSSL_BIN to its path.",
    { cause },
  );
}

/**
 * Fail before any test does, with a message naming the dependency and the lane
 * that lacks it, instead of a bare `spawn openssl ENOENT` that reads like a
 * product fault.
 */
export async function assertOpensslAvailable() {
  try {
    await execFileAsync(OPENSSL_BIN, ["version"]);
  } catch (error) {
    if (error?.code === "ENOENT") throw missingOpensslError(error);
    throw error;
  }
}

export async function generateTlsPair(directory, name) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const certFile = join(directory, `${name}-cert.pem`);
  const keyFile = join(directory, `${name}-key.pem`);
  try {
    await execFileAsync(OPENSSL_BIN, [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "2",
      "-subj",
      "/CN=dash.example.test",
      "-addext",
      "subjectAltName=DNS:dash.example.test",
      "-keyout",
      keyFile,
      "-out",
      certFile,
    ]);
  } catch (error) {
    if (error?.code === "ENOENT") throw missingOpensslError(error);
    throw error;
  }
  // Set both modes explicitly: openssl honours the ambient umask, so the
  // permissions these cases assert must not be inherited from the environment.
  await Promise.all([chmod(certFile, 0o644), chmod(keyFile, 0o600)]);
  return { certFile, keyFile };
}
