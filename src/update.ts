import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";
import pkg from "../package.json" with { type: "json" };

const NAME = "@elumixor/devkit";

/**
 * Bring devkit to the newest published version: the global `devkit` on PATH always, and the
 * project's own dependency when the current directory declares one. A pinned version stays pinned.
 */
export async function runUpdate(dry = false) {
  const response = await fetch(`https://registry.npmjs.org/${NAME}/latest`);
  if (!response.ok) throw new Error(`npm registry answered ${response.status} for ${NAME}`);
  const latest = ((await response.json()) as { version: string }).version;

  console.log(`global: ${pkg.version} -> ${latest}`);
  if (!dry) await $`bun add -g ${NAME}@${latest}`.quiet();

  const manifestPath = resolve("package.json");
  if (!existsSync(manifestPath)) return;
  const manifest = await Bun.file(manifestPath).json();
  const dev = manifest.devDependencies?.[NAME] as string | undefined;
  const spec = dev ?? (manifest.dependencies?.[NAME] as string | undefined);
  if (!spec) return;

  const pinned = /^\d/.test(spec);
  console.log(`${manifest.name ?? "project"}: ${spec} -> ${pinned ? "" : "^"}${latest}`);
  if (dry) return;
  const flags = [...(dev ? ["-d"] : []), ...(pinned ? ["--exact"] : [])];
  await $`bun add ${flags} ${NAME}@${latest}`.quiet();
}
