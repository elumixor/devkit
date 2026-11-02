import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CloudError } from "./aws.ts";
import { type Env, parseDotenv } from "./env.ts";

const DOTENV_FILES = [".env", ".env.local", ".env.production", ".env.production.local"];
const TEXT_FILE = /\.(js|mjs|css|html|json|txt|map)$/;
/** Shorter values (`1`, `true`, a port) appear in any bundle by chance. */
const MIN_VALUE_LENGTH = 8;

/**
 * A laptop's `.env` holds development values (a test Clerk key, a local URL). A deploy builds with the
 * stage's variables, but a bundler that reads `.env` files itself can still bake a local value in, and
 * the result is a production site talking to development services. This refuses such a build.
 */
export async function assertNoLocalEnvInBuild(staticDir: string, dirs: readonly string[], stageEnv: Env) {
  const leaks = new Map<string, string>();
  for (const dir of dirs)
    for (const name of DOTENV_FILES) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      for (const [key, value] of Object.entries(parseDotenv(await Bun.file(file).text())))
        if (key in stageEnv && stageEnv[key] !== value && value.length >= MIN_VALUE_LENGTH) leaks.set(value, key);
    }
  if (!leaks.size || !existsSync(staticDir)) return;

  for (const entry of await readdir(staticDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !TEXT_FILE.test(entry.name)) continue;
    const text = await Bun.file(resolve(entry.parentPath, entry.name)).text();
    for (const [value, key] of leaks)
      if (text.includes(value))
        throw new CloudError(
          `The build has the local .env value of ${key} in ${entry.name}, not the stage's — nothing was uploaded`,
        );
  }
}
