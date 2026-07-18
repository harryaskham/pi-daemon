import { gzipSync } from "node:zlib";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const artifact = fileURLToPath(new URL("../artifacts/performance.json", import.meta.url));

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else files.push(path);
  }
  return files;
}

const files = await filesUnder(dist);
const rows = [];
for (const path of files) {
  if (path.endsWith(".map")) continue;
  const bytes = await readFile(path);
  rows.push({ file: relative(dist, path), bytes: (await stat(path)).size, gzipBytes: gzipSync(bytes).byteLength });
}
rows.sort((a, b) => b.gzipBytes - a.gzipBytes);
const scriptRows = rows.filter((row) => row.file.endsWith(".js"));
const manifest = JSON.parse(await readFile(join(dist, ".vite", "manifest.json"), "utf8"));
const entry = manifest["index.html"];
const initialFiles = new Set(["index.html", entry.file, ...(entry.css ?? [])]);
const visitImports = (record) => {
  for (const key of record.imports ?? []) {
    const imported = manifest[key];
    if (!imported || initialFiles.has(imported.file)) continue;
    initialFiles.add(imported.file);
    visitImports(imported);
  }
};
visitImports(entry);
const initialRows = rows.filter((row) => initialFiles.has(row.file));
const initialGzipBytes = initialRows.reduce((sum, row) => sum + row.gzipBytes, 0);
const report = {
  measuredAt: new Date().toISOString(),
  source: "vite production output",
  budget: { initialGzipBytes: 1_572_864 },
  totals: {
    allBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    allGzipBytes: rows.reduce((sum, row) => sum + row.gzipBytes, 0),
    scriptGzipBytes: scriptRows.reduce((sum, row) => sum + row.gzipBytes, 0),
    initialGzipBytes,
    lazyGzipBytes: rows.reduce((sum, row) => sum + row.gzipBytes, 0) - initialGzipBytes,
  },
  files: rows,
};
let existing = {};
try { existing = JSON.parse(await readFile(artifact, "utf8")); } catch {}
await mkdir(dirname(artifact), { recursive: true });
await writeFile(artifact, `${JSON.stringify({ ...existing, ...report }, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
