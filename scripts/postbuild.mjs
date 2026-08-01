#!/usr/bin/env node
import { chmod, copyFile, cp, mkdir, stat } from "node:fs/promises";
import { writeSourceDistFingerprint } from "./source-dist-fingerprint.mjs";

const root = new URL("..", import.meta.url);
await mkdir(new URL("../dist", import.meta.url), { recursive: true });
for (const bin of ["cli.js", "rpc-stdio-cli.js"]) {
  await chmod(new URL(`../dist/${bin}`, import.meta.url), 0o755).catch(() => {});
}
// `build:src` compiles the server without rebuilding the Dash SPA, so the
// compiled SPA may legitimately be absent. Say so plainly instead of failing
// with a bare ENOENT: anything that serves `/dash/` needs the full `npm run
// build`, and a missing SPA otherwise surfaces much later as a 404.
const webDist = new URL("../web/dist", import.meta.url);
const hasWebDist = await stat(webDist).then((entry) => entry.isDirectory(), () => false);
if (hasWebDist) {
  await cp(webDist, new URL("../dist/dashboard", import.meta.url), {
    recursive: true,
    force: true,
  });
} else {
  process.stdout.write(
    "postbuild: web/dist is absent, so dist/dashboard was not written. " +
      "Run `npm run build` before anything that serves or asserts the packaged Dash SPA.\n",
  );
}
for (const contract of [
  "protocol.schema.json",
  "protocol-v2.schema.json",
  "tool-adapter.schema.json",
  "session-api.schema.json",
  "session-api.openapi.json",
  "dashboard-api.schema.json",
  "extension-view.schema.json",
  "dashboard-api.openapi.json",
  "dashboard-session-draft.schema.json",
  "schedule.schema.json",
]) {
  await copyFile(new URL(`../${contract}`, import.meta.url), new URL(`../dist/${contract}`, import.meta.url));
}
await writeSourceDistFingerprint();
