import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "./config.ts";

/**
 * Secrets that cannot be regenerated from any host (.env, terraform.tfvars) are
 * age-encrypted into a private git repo, one directory per project.
 *
 * The only thing a new machine must carry is the age identity. Everything else
 * follows from `gh auth login`.
 */
export const KEY_PATH = join(homedir(), ".config/age/key.txt");
const CACHE = join(homedir(), ".cache/devkit/secrets");
const DEFAULT_REPO = "elumixor/secrets";

/** `recipients.txt` lets any machine holding *a* key encrypt for *all* keys. */
const RECIPIENTS = "recipients.txt";

function requireKey() {
  if (existsSync(KEY_PATH)) return;
  throw new Error(
    `No age identity at ${KEY_PATH}.\n\n` +
      `It is the one thing that must be carried to a new machine — without it the\n` +
      `encrypted secrets cannot be read. Copy it over, or create a new identity with\n` +
      `\`age-keygen -o ${KEY_PATH}\` and re-encrypt from a machine that still has the old one.`,
  );
}

/** Clone the secrets repo on first use, otherwise fast-forward it. */
async function syncCache(repo: string) {
  if (existsSync(join(CACHE, ".git"))) {
    await $`git pull --quiet --ff-only`.cwd(CACHE);
  } else {
    await mkdir(dirname(CACHE), { recursive: true });
    await $`gh repo clone ${repo} ${CACHE} -- --quiet`.quiet();
  }
  return CACHE;
}

/** Project directory inside the secrets repo — the repo name, so it matches `devkit clone`. */
async function projectName(root: string) {
  const remote = await $`git -C ${root} remote get-url origin`.quiet().nothrow().text();
  const name = remote.trim().replace(/\.git$/, "").split("/").pop();
  if (name) return name;
  const pkg = await Bun.file(resolve(root, "package.json")).json();
  return pkg.name as string;
}

function config(root: string) {
  const setup = loadConfig(root).setup ?? {};
  const files = setup.secrets ?? [];
  if (!files.length) throw new Error('No "devkit.setup.secrets" in package.json — nothing to sync.');
  return { files, repo: setup.secretsRepo ?? DEFAULT_REPO };
}

/** Encrypt the project's secret files into the secrets repo and push. */
export async function pushSecrets(root = process.cwd()) {
  requireKey();
  const { files, repo } = config(root);
  const cache = await syncCache(repo);
  const project = await projectName(root);

  // Seed recipients.txt on first push so other machines can encrypt for this key too.
  const recipientsPath = join(cache, RECIPIENTS);
  if (!existsSync(recipientsPath)) {
    await Bun.write(recipientsPath, `${(await $`age-keygen -y ${KEY_PATH}`.text()).trim()}\n`);
  }

  let pushed = 0;
  for (const file of files) {
    const source = resolve(root, file);
    if (!existsSync(source)) {
      console.log(`  skip ${file} (not present)`);
      continue;
    }
    const target = join(cache, project, `${file}.age`);
    await mkdir(dirname(target), { recursive: true });
    await $`age --encrypt --recipients-file ${recipientsPath} --output ${target} ${source}`;
    console.log(`  encrypted ${file}`);
    pushed++;
  }
  if (!pushed) return console.log("Nothing to push.");

  await $`git add -A`.cwd(cache);
  const clean = await $`git diff --cached --quiet`.cwd(cache).nothrow();
  if (clean.exitCode === 0) return console.log("Already up to date.");

  await $`git commit --quiet -m ${`secrets: update ${project}`}`.cwd(cache);
  await $`git push --quiet`.cwd(cache);
  console.log(`Pushed ${pushed} file(s) for ${project} to ${repo}.`);
}

/** Decrypt this project's secret files from the secrets repo into the working tree. */
export async function pullSecrets(root = process.cwd()) {
  requireKey();
  const { files, repo } = config(root);
  const cache = await syncCache(repo);
  const project = await projectName(root);

  for (const file of files) {
    const source = join(cache, project, `${file}.age`);
    if (!existsSync(source)) {
      console.log(`  skip ${file} (not in ${repo}/${project})`);
      continue;
    }
    const target = resolve(root, file);
    await mkdir(dirname(target), { recursive: true });
    await $`age --decrypt --identity ${KEY_PATH} --output ${target} ${source}`;
    console.log(`  decrypted ${file}`);
  }
}
