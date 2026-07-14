import { $ } from "bun";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "./config.ts";

/**
 * Secrets that cannot be regenerated from any host (.env, terraform.tfvars) are
 * encrypted into a private git repo, one bundle per project.
 *
 * The only thing you need on a new machine is `gh auth login` and one passphrase.
 * No key file to carry, no OS-specific keychain, no external crypto binary — which
 * is why this uses node:crypto rather than shelling out to `age`.
 */
const CACHE = join(homedir(), ".cache/devkit/secrets");
const PASSPHRASE_FILE = join(homedir(), ".config/devkit/passphrase");
const DEFAULT_REPO = "elumixor/secrets";

/** scrypt is deliberately slow; these are the Node defaults raised for a user-chosen passphrase. */
const SCRYPT = { N: 2 ** 16, r: 8, p: 1, maxmem: 128 * 2 ** 16 * 8 * 2 };
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;

/** Read a passphrase without echoing it. `stty` beats a bare prompt(), which would print it. */
async function ask(question: string) {
  process.stdout.write(question);
  const result = await $`sh -c ${'stty -echo 2>/dev/null; read -r p; stty echo 2>/dev/null; printf "%s" "$p"'}`
    .nothrow()
    .text();
  process.stdout.write("\n");
  return result.trim();
}

/**
 * The passphrase, cached per-machine after first use. Cached in plaintext on purpose:
 * it guards the *transport*, and the files it protects sit in the working tree in
 * plaintext anyway, so encrypting the cache would be theatre.
 */
async function passphrase(confirm = false) {
  const fromEnv = process.env.DEVKIT_PASSPHRASE;
  if (fromEnv) return fromEnv;

  if (existsSync(PASSPHRASE_FILE)) return (await Bun.file(PASSPHRASE_FILE).text()).trim();

  const entered = await ask("Secrets passphrase: ");
  if (!entered) throw new Error("No passphrase given.");
  if (confirm && (await ask("Confirm passphrase: ")) !== entered) {
    throw new Error("Passphrases do not match.");
  }

  await mkdir(dirname(PASSPHRASE_FILE), { recursive: true });
  await Bun.write(PASSPHRASE_FILE, `${entered}\n`);
  await chmod(PASSPHRASE_FILE, 0o600);
  console.log(`  cached in ${PASSPHRASE_FILE} — you won't be asked again on this machine`);
  return entered;
}

/** salt | iv | tag | ciphertext, base64 — one self-contained blob, diffable enough for git. */
function encrypt(plaintext: string, secret: string) {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = scryptSync(secret, salt, KEY_LEN, SCRYPT);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([salt, iv, cipher.getAuthTag(), body]).toString("base64");
}

function decrypt(blob: string, secret: string) {
  const raw = Buffer.from(blob, "base64");
  const salt = raw.subarray(0, SALT_LEN);
  const iv = raw.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = raw.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + 16);
  const body = raw.subarray(SALT_LEN + IV_LEN + 16);
  const key = scryptSync(secret, salt, KEY_LEN, SCRYPT);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    // GCM's auth tag is what catches this; there is no other way to be "wrong".
    throw new Error(
      `Could not decrypt — wrong passphrase.\n\nClear the cached one and retry:\n  rm ${PASSPHRASE_FILE}`,
    );
  }
}

/** Clone the secrets repo on first use, otherwise fast-forward it. */
async function syncCache(repo: string) {
  if (existsSync(join(CACHE, ".git"))) await $`git pull --quiet --ff-only`.cwd(CACHE).quiet();
  else {
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
  return (await Bun.file(resolve(root, "package.json")).json()).name as string;
}

function config(root: string) {
  const setup = loadConfig(root).setup ?? {};
  const files = setup.secrets ?? [];
  if (!files.length) throw new Error('No "devkit.setup.secrets" in package.json — nothing to sync.');
  return { files, repo: setup.secretsRepo ?? DEFAULT_REPO };
}

/** Encrypt the project's secret files into one bundle and push it. */
export async function pushSecrets(root = process.cwd()) {
  const { files, repo } = config(root);
  const cache = await syncCache(repo);
  const project = await projectName(root);
  const bundlePath = join(cache, `${project}.enc`);

  // Only confirm when creating a project's first bundle — a typo there would be
  // unrecoverable, whereas a typo on a later push just fails to decrypt the old one.
  const secret = await passphrase(!existsSync(bundlePath));

  const bundle: Record<string, string> = {};
  for (const file of files) {
    const source = resolve(root, file);
    if (!existsSync(source)) {
      console.log(`  skip ${file} (not present)`);
      continue;
    }
    bundle[file] = await Bun.file(source).text();
    console.log(`  packed ${file}`);
  }
  if (!Object.keys(bundle).length) return console.log("Nothing to push.");

  await Bun.write(bundlePath, `${encrypt(JSON.stringify(bundle), secret)}\n`);

  await $`git add -A`.cwd(cache).quiet();
  if ((await $`git diff --cached --quiet`.cwd(cache).nothrow()).exitCode === 0) {
    return console.log("Already up to date.");
  }
  await $`git commit --quiet -m ${`secrets: update ${project}`}`.cwd(cache).quiet();
  await $`git push --quiet`.cwd(cache).quiet();
  console.log(`Pushed ${Object.keys(bundle).length} file(s) for ${project} to ${repo}.`);
}

/** Decrypt this project's bundle into the working tree. */
export async function pullSecrets(root = process.cwd()) {
  const { repo } = config(root);
  const cache = await syncCache(repo);
  const project = await projectName(root);
  const bundlePath = join(cache, `${project}.enc`);

  if (!existsSync(bundlePath)) {
    console.log(`  no secrets stored for ${project} in ${repo} — run \`devkit secrets push\` first`);
    return;
  }

  const secret = await passphrase();
  const bundle: Record<string, string> = JSON.parse(
    decrypt(await Bun.file(bundlePath).text(), secret),
  );

  for (const [file, contents] of Object.entries(bundle)) {
    const target = resolve(root, file);
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, contents);
    await chmod(target, 0o600);
    console.log(`  restored ${file}`);
  }
}
