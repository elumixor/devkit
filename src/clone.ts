import { $ } from "bun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pullSecrets } from "./secrets.ts";
import { runSetup } from "./setup.ts";

/** Fail early and actionably, rather than midway through with a raw ENOENT. */
async function checkPrereqs() {
  if (!Bun.which("gh")) {
    throw new Error("`gh` is not installed.\n\n  brew install gh   (or see cli.github.com)");
  }
  if ((await $`gh auth status`.nothrow().quiet()).exitCode !== 0) {
    throw new Error("Not logged in to GitHub.\n\n  gh auth login");
  }
}

/**
 * Clone a repo and make it runnable in one step: clone, decrypt its secrets, set up.
 * A new machine needs `gh auth login` and the secrets passphrase — nothing else.
 */
export async function runClone(repo: string, dir?: string) {
  await checkPrereqs();

  const target = resolve(dir ?? repo.split("/").pop() ?? repo);

  if (existsSync(target)) console.log(`${target} already exists — skipping clone.`);
  else {
    console.log(`Cloning ${repo}…`);
    await $`gh repo clone ${repo} ${target}`;
  }

  process.chdir(target);

  console.log("\nRestoring secrets…");
  await pullSecrets(target);

  console.log("");
  await runSetup();
}
