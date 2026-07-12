#!/usr/bin/env node
import { chmod, copyFile, mkdir } from "node:fs/promises";
const root = new URL("..", import.meta.url);
await mkdir(new URL("../dist", import.meta.url), { recursive: true });
await chmod(new URL("../dist/cli.js", import.meta.url), 0o755).catch(() => {});
await copyFile(new URL("../protocol.schema.json", import.meta.url), new URL("../dist/protocol.schema.json", import.meta.url));
