#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function parseArguments(arguments_) {
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error("expected --artifact, --jar, --output and optional --exclude-prefix");
    }
    values[name.slice(2)] = value;
  }
  for (const required of ["artifact", "jar", "output"]) {
    if (!values[required]) throw new Error(`--${required} is required`);
  }
  return values;
}

function jarClasses(jar) {
  return execFileSync("jar", ["--list", "--file", jar], { encoding: "utf8" })
    .split("\n")
    .filter((entry) => entry.endsWith(".class") && !entry.startsWith("META-INF/"))
    .map((entry) => entry.slice(0, -".class".length).replaceAll("/", "."))
    .sort();
}

function normalizedJavap(jar, className) {
  const output = execFileSync("javap", ["-classpath", jar, "-public", "-constants", className], { encoding: "utf8" });
  return output
    .split("\n")
    .filter((line) => line && !line.startsWith("Compiled from "))
    .join("\n")
    .replace(
      /\$(?:pi_droid_sdk_(?:core|session_ui|workspace_ui)|sdk_(?:core|session_ui|workspace_ui)_android)\b/gu,
      () => "$MODULE",
    );
}

export function snapshotSdkApi({ artifact, jar, excludePrefixes = [] }) {
  const classes = jarClasses(jar).filter((className) => !excludePrefixes.some((prefix) => className.startsWith(prefix)));
  const signatures = classes.map((className) => normalizedJavap(jar, className));
  return [
    "# Pi Droid SDK binary API baseline",
    `# artifact=${artifact}`,
    "# version=0.3.0-alpha.1",
    "# Generated with jar+javap -public -constants; update only with migration notes.",
    "",
    ...signatures.flatMap((signature) => [signature, ""]),
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = parseArguments(process.argv.slice(2));
  const output = snapshotSdkApi({
    artifact: arguments_.artifact,
    jar: resolve(arguments_.jar),
    excludePrefixes: arguments_["exclude-prefix"] ? arguments_["exclude-prefix"].split(",") : [],
  });
  writeFileSync(resolve(arguments_.output), output);
  process.stdout.write(`Pi Droid SDK API baseline: ${arguments_.artifact} bytes=${Buffer.byteLength(output)}\n`);
}
