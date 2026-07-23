import { execFile } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function generateTlsPair(directory, name) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const certFile = join(directory, `${name}-cert.pem`);
  const keyFile = join(directory, `${name}-key.pem`);
  await execFileAsync("openssl", [
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
  await Promise.all([chmod(certFile, 0o644), chmod(keyFile, 0o600)]);
  return { certFile, keyFile };
}
