import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** One dev process. Resolved into a shell command by {@link commandFor}. */
export interface DevApp {
  /** Display name; also the default `bun --filter` target. */
  name?: string;
  /** Explicit `bun --filter <target>` (defaults to `name`). */
  filter?: string;
  /** Run via `bun --cwd <cwd> run <script>` instead of `--filter`. */
  cwd?: string;
  /** Script to run in the workspace (default `dev`). */
  script?: string;
  /** Raw shell command; overrides filter/cwd/script (e.g. `vite dev`). */
  command?: string;
  /** Port to free on start and show in the URL banner. */
  port?: number;
  /** Prefix color for this process's output. */
  color?: string;
  /** With `--open`, open this app's URL once its port is live. */
  open?: boolean;
}

/** A gitignored env file that must be carried to a new machine, and the template listing its keys. */
export interface EnvFile {
  /** Path to the env file, relative to the root (default `.env`). */
  file?: string;
  /** Committed template whose keys must all be present and non-empty (default `<file>.example`). */
  example?: string;
}

/**
 * `devkit setup` config: what a fresh clone needs before it can run.
 *
 * Setup never writes secrets. Env files are validated, not generated — see the README
 * for why fetching them back from a host (e.g. `vercel env pull`) is not safe.
 */
export interface SetupConfig {
  /** Env files to validate. Defaults to a single `.env` / `.env.example` pair. */
  env?: EnvFile[];
  /**
   * Gitignored files that cannot be regenerated from any host, synced age-encrypted
   * via `devkit secrets push|pull` (e.g. `[".env", "infra/terraform.tfvars"]`).
   */
  secrets?: string[];
  /** Private repo holding the encrypted secrets (default `elumixor/secrets`). */
  secretsRepo?: string;
  /** Directory holding Terraform. Initialised only if it has a `terraform.tfvars`. */
  terraform?: string;
  /** Run `bun install` at the root (default true). */
  install?: boolean;
  /** Shell commands to run last, in order (e.g. `bun --filter backend prisma:generate`). */
  steps?: string[];
}

export interface DevkitConfig {
  apps: DevApp[];
  setup?: SetupConfig;
}

/** Read the `devkit` config from the nearest package.json. */
export function loadConfig(dir: string = process.cwd()): DevkitConfig {
  const pkgPath = resolve(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { devkit?: DevkitConfig };
  const cfg = pkg.devkit;
  if (!cfg?.apps?.length) {
    throw new Error(`No "devkit.apps" found in ${pkgPath}`);
  }
  return cfg;
}
