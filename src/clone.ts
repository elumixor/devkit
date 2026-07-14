import { $ } from "bun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pullSecrets } from "./secrets.ts";
import { runSetup } from "./setup.ts";

/**
 * Clone a repo and make it runnable in one step: `gh repo clone`, decrypt its
 * secrets, then run setup. The whole point is that a new machine needs nothing
 * but `gh auth login` and the age identity.
 */
export async function runClone(repo: string, dir?: string) {
  const target = resolve(dir ?? repo.split("/").pop() ?? repo);

  if (existsSync(target)) {
    console.log(`${target} already exists — skipping clone.`);
  } else {
    console.log(`Cloning ${repo}…`);
    await $`gh repo clone ${repo} ${target}`;
  }

  process.chdir(target);

  console.log("\nFetching secrets…");
  await pullSecrets(target);

  console.log("");
  await runSetup();
}
