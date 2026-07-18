#!/usr/bin/env node
import { chmod, copyFile, cp, mkdir } from "node:fs/promises";
const root = new URL("..", import.meta.url);
await mkdir(new URL("../dist", import.meta.url), { recursive: true });
for (const bin of ["cli.js", "rpc-stdio-cli.js"]) {
  await chmod(new URL(`../dist/${bin}`, import.meta.url), 0o755).catch(() => {});
}
await cp(new URL("../web/dist", import.meta.url), new URL("../dist/dashboard", import.meta.url), {
  recursive: true,
  force: true,
});
for (const contract of [
  "protocol.schema.json",
  "protocol-v2.schema.json",
  "tool-adapter.schema.json",
  "session-api.schema.json",
  "session-api.openapi.json",
  "dashboard-api.schema.json",
  "dashboard-api.openapi.json",
  "schedule.schema.json",
]) {
  await copyFile(new URL(`../${contract}`, import.meta.url), new URL(`../dist/${contract}`, import.meta.url));
}
