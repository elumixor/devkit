import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** One dev process, keyed by its name. Resolved into a shell command by {@link commandFor}. */
export interface DevApp {
  /** Explicit `bun --filter <target>` (defaults to the name). */
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

/**
 * One deploy step. Targets with no `needs` all start at once; a target with `needs` waits for
 * those, which is what lets a build that another one packages up run first without serialising
 * the whole release.
 */
export interface DeployTarget {
  /** Shell command that performs this deploy. Omit when `type` names a built-in target instead. */
  command?: string;
  /** A built-in deploy target — see `src/deploy-targets/`. `options` is that target's own config. */
  type?: "vercel" | "tauri-macos" | "fastlane-ios";
  // biome-ignore lint/suspicious/noExplicitAny: each `type` has its own options shape
  options?: any;
  /** Targets that must finish first. */
  needs?: string[];
  /** Colour for this target's line on the board. */
  color?: string;
}

/** Apps and deploy targets are written as name-keyed maps, so a name is never repeated or missing. */
export interface DevkitConfig {
  apps?: Record<string, DevApp>;
  setup?: SetupConfig;
  deploy?: Record<string, DeployTarget>;
}

/** A config entry with its map key attached — the name every command prints and refers to. */
export type Named<T> = T & { readonly name: string };

/** What the commands read: the same config, with each map flattened into named entries. */
export interface LoadedConfig {
  apps: Named<DevApp>[];
  setup?: SetupConfig;
  deploy: Named<DeployTarget>[];
}

/** Read the `devkit` config from the nearest package.json. */
export function loadConfig(dir: string = process.cwd()): LoadedConfig {
  const pkgPath = resolve(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { devkit?: DevkitConfig };
  const cfg = pkg.devkit;
  // `devkit deploy` is useful in a repo that runs nothing locally, so only the dev command
  // insists on apps.
  if (!cfg) throw new Error(`No "devkit" config found in ${pkgPath}`);
  return {
    apps: named(cfg.apps, "apps", pkgPath),
    setup: cfg.setup,
    deploy: named(cfg.deploy, "deploy", pkgPath),
  };
}

function named<T>(map: Record<string, T> | undefined, key: string, pkgPath: string): Named<T>[] {
  if (map === undefined) return [];
  if (Array.isArray(map))
    throw new Error(`"devkit.${key}" in ${pkgPath} is a list — it is now a map of name to settings`);
  return Object.entries(map).map(([name, entry]) => ({ ...entry, name }));
}
