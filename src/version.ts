import { resolve } from "node:path";
import { loadConfig } from "./config.ts";

/**
 * One version for the whole product. A single file holds it — the one the app already reads its
 * version from at build time — and this writes that number everywhere else a version is declared,
 * so the App Store, the installer and the line at the bottom of settings can't drift apart.
 */
export async function runVersion() {
  const { version: config } = loadConfig();
  if (!config) throw new Error('No "devkit.version" config in package.json');

  const root = process.cwd();
  const sourcePath = resolve(root, config.source);
  const version = (await Bun.file(sourcePath).json()).version as string | undefined;
  if (!version || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`${sourcePath} has no plain x.y.z version: ${version}`);

  const path = (file: string) => resolve(root, file);

  await Promise.all([
    ...(config.packages ?? []).map((file) => edit(path(file), /("version":\s*")[^"]+/, version)),
    ...(config.cargo ?? []).map((file) => edit(path(file), /(^version = ")[^"]+/m, version)),
    // The Xcode project is the only place the iOS marketing version is written: each Info.plist
    // that belongs to a target reads `$(MARKETING_VERSION)` from it.
    ...(config.xcodeProjects ?? []).map((file) => edit(path(file), /(MARKETING_VERSION = )[^;]+/g, version)),
    ...(config.marketingVersionPlists ?? []).map((file) => edit(path(file), SHORT_VERSION, "$(MARKETING_VERSION)")),
    // Targets wired into a project by a script rather than by Xcode's template have no
    // `MARKETING_VERSION` setting of their own, so their plists carry the number itself.
    ...(config.plists ?? []).map((file) => edit(path(file), SHORT_VERSION, version)),
  ]);

  console.log(`Version ${version} across every declared file`);
}

const SHORT_VERSION = /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]+/;

/** Rewrites the part of `pattern` after its first capture group, leaving the rest of the file alone. */
async function edit(path: string, pattern: RegExp, value: string) {
  const before = await Bun.file(path).text();
  const after = before.replace(pattern, (_, prefix) => `${prefix}${value}`);
  if (after !== before) await Bun.write(path, after);
}
