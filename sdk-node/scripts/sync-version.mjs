#!/usr/bin/env node
/**
 * Writes src/version.ts from the current package.json#version so the
 * SDK_VERSION constant can't drift from what's actually published. Runs
 * as a prebuild + pretest step; committing the result keeps in-IDE
 * imports / typecheck happy without requiring a watcher.
 */
import { readFile, writeFile } from "node:fs/promises";

const pkgUrl = new URL("../package.json", import.meta.url);
const versionUrl = new URL("../src/version.ts", import.meta.url);

const pkg = JSON.parse(await readFile(pkgUrl, "utf-8"));
const version = pkg.version;

const source = `/**
 * Single source of truth for the SDK version string. Generated from
 * package.json#version by scripts/sync-version.mjs — do not edit by hand;
 * bump the version in package.json and re-run \`pnpm build\` (or let the
 * prebuild hook sync automatically).
 */
export const SDK_VERSION = ${JSON.stringify(version)};
`;

const existing = await readFile(versionUrl, "utf-8").catch(() => "");
if (existing !== source) {
  await writeFile(versionUrl, source);
  console.log(`[sync-version] wrote src/version.ts (${version})`);
} else {
  console.log(`[sync-version] src/version.ts already matches (${version})`);
}
