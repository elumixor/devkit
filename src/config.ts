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

/**
 * `devkit build`: a client-rendered web app and a Nitro API packed into one Vercel deployment.
 */
export interface BuildConfig {
  /** Web app dir, run with `bun run build` (default `apps/frontend`). */
  frontendDir?: string;
  /** Nitro dir, built with `bunx nitro build --preset vercel` (default `apps/backend`). */
  backendDir?: string;
  /** Where the web build lands inside `frontendDir` (default `build`). */
  webBuildDir?: string;
  /** Path prefixes the API owns; everything else answers with the app shell. */
  apiPrefixes: string[];
  /** Run in `backendDir` before the web build, unless `SKIP_CLIENT_GEN` is set (e.g. `bunx nitro-client`). */
  clientCommand?: string;
  /** Extra staged directories to serve, as `{ "<source dir>": "<path under the site>" }`. */
  include?: Record<string, string>;
}

/** `devkit sim`: an Apple app built and launched on a simulator, without opening Xcode. */
export interface SimConfig {
  /** Path to the `.xcodeproj`. */
  project: string;
  /** Scheme to build; also the name of the built `.app`. */
  scheme: string;
  /** Bundle id to install and launch. */
  bundleId: string;
  /** Simulator to run on — overridable with `--device` or `DEVKIT_SIM_DEVICE`. */
  device: string;
  /** Simulator SDK the products are built for (default `watchsimulator`). */
  sdk?: string;
  /** Derived data dir (default `build/sim`). */
  derivedDataDir?: string;
  /** Env var the app reads to show sample data; set unless `--real` is passed. */
  previewEnv?: string;
}

/** `devkit version`: one version, declared once and written everywhere else it appears. */
export interface VersionConfig {
  /** JSON file whose `version` field is the number the rest follow. */
  source: string;
  /** `package.json`-shaped files. */
  packages?: string[];
  /** `Cargo.toml` files. */
  cargo?: string[];
  /** `project.pbxproj` files, whose `MARKETING_VERSION` every target's plist reads. */
  xcodeProjects?: string[];
  /** Plists of targets in those projects — pointed at `$(MARKETING_VERSION)` rather than a number. */
  marketingVersionPlists?: string[];
  /** Plists of targets with no project setting of their own, which carry the number itself. */
  plists?: string[];
}

/** Apps and deploy targets are written as name-keyed maps, so a name is never repeated or missing. */
export interface DevkitConfig {
  apps?: Record<string, DevApp>;
  setup?: SetupConfig;
  deploy?: Record<string, DeployTarget>;
  build?: BuildConfig;
  sim?: SimConfig;
  version?: VersionConfig;
}

/** A config entry with its map key attached — the name every command prints and refers to. */
export type Named<T> = T & { readonly name: string };

/** What the commands read: the same config, with each map flattened into named entries. */
export interface LoadedConfig {
  apps: Named<DevApp>[];
  setup?: SetupConfig;
  deploy: Named<DeployTarget>[];
  build?: BuildConfig;
  sim?: SimConfig;
  version?: VersionConfig;
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
    build: cfg.build,
    sim: cfg.sim,
    version: cfg.version,
  };
}

function named<T>(map: Record<string, T> | undefined, key: string, pkgPath: string): Named<T>[] {
  if (map === undefined) return [];
  if (Array.isArray(map))
    throw new Error(`"devkit.${key}" in ${pkgPath} is a list — it is now a map of name to settings`);
  return Object.entries(map).map(([name, entry]) => ({ ...entry, name }));
}
