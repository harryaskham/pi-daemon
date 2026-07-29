#!/usr/bin/env node
// Remove build output.
//
// `--keep-web` leaves `web/dist` in place. The compiled Dash SPA is expensive
// to rebuild and changes only when its own sources do, so a focused loop over
// `src/**` can drop the server output alone and let `postbuild` copy the
// existing SPA back into `dist/dashboard`.
import { rm } from "node:fs/promises";

const keepWeb = process.argv.slice(2).includes("--keep-web");

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
if (!keepWeb) {
  await rm(new URL("../web/dist", import.meta.url), { recursive: true, force: true });
}
