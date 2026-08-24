import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The three things a repo does with its platforms, and the three commands that do them.
 *
 * Every phase is the same shape — a map of platform name to one step — so `devkit build` and
 * `devkit build:mac` are the same command with a different selection, and a platform is named
 * once and means the same thing everywhere.
 */
export type Phase = "dev" | "build" | "deploy";

export const PHASES: readonly Phase[] = ["dev", "build", "deploy"];

/** One step of a phase: a shell command, or a built-in target named by `type`. */
export interface Step {
  /** Shell command that performs this step. Omit when `type` names a built-in target instead. */
  command?: string;
  /** A built-in target — see `src/<phase>-targets/`. `options` is that target's own config. */
  type?: string;
  // biome-ignore lint/suspicious/noExplicitAny: each `type` has its own options shape
  options?: any;
  /** Platforms that must run first — built before this one, or already up in the dev case. */
  needs?: string[];
  /** Colour for this step's line on the board. */
  color?: string;
}

/** One long-running dev process. Resolved into a shell command by `commandFor` in `dev.ts`. */
export interface DevProcess extends Step {
  /** Explicit `bun --filter <target>` (defaults to the process name). */
  filter?: string;
  /** Run via `bun run --cwd <cwd> <script>` instead of `--filter`. */
  cwd?: string;
  /** Script to run in the workspace (default `dev`). */
  script?: string;
  /** Port to free on start and show in the URL banner. */
  port?: number;
  /** With `--open`, open this process's URL once its port is live. */
  open?: boolean;
}

/**
 * One platform's dev setup: either a single process, or several under `processes` — a web
 * platform is a client and an API, and neither is worth naming as a platform of its own.
 */
export interface DevPlatform extends DevProcess {
  processes?: Record<string, DevProcess>;
}

/** A command run once before a build or deploy graph, ahead of everything running in parallel. */
export interface GenerateConfig {
  /** Shell command to run (e.g. `bunx nitro-client`). */
  command: string;
  /** Directory to run it in, relative to the root (default `.`). */
  cwd?: string;
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

/** Phases are name-keyed maps, so a platform is never repeated or missing a name. */
export interface DevkitConfig {
  dev?: Record<string, DevPlatform>;
  build?: Record<string, Step>;
  deploy?: Record<string, Step>;
  generate?: GenerateConfig;
  setup?: SetupConfig;
  version?: VersionConfig;
}

/** A config entry with its map key attached — the name every command prints and refers to. */
export type Named<T> = T & { readonly name: string };

/** What the commands read: the same config, with each map flattened into named entries. */
export interface LoadedConfig {
  dev: Named<DevPlatform>[];
  build: Named<Step>[];
  deploy: Named<Step>[];
  generate?: GenerateConfig;
  setup?: SetupConfig;
  version?: VersionConfig;
}

/** Read the `devkit` config from the nearest package.json. */
export function loadConfig(dir: string = process.cwd()): LoadedConfig {
  const pkgPath = resolve(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { devkit?: DevkitConfig };
  const cfg = pkg.devkit;
  // `devkit deploy` is useful in a repo that runs nothing locally, so no phase is required here —
  // each command says what it needs when it finds nothing to run.
  if (!cfg) throw new Error(`No "devkit" config found in ${pkgPath}`);
  return {
    dev: named(cfg.dev, "dev", pkgPath),
    build: named(cfg.build, "build", pkgPath),
    deploy: named(cfg.deploy, "deploy", pkgPath),
    generate: cfg.generate,
    setup: cfg.setup,
    version: cfg.version,
  };
}

/** The entries of one phase, in config order. */
export function phaseOf(config: LoadedConfig, phase: Phase): Named<Step>[] {
  return phase === "dev" ? config.dev : phase === "build" ? config.build : config.deploy;
}

function named<T>(map: Record<string, T> | undefined, key: string, pkgPath: string): Named<T>[] {
  if (map === undefined) return [];
  if (Array.isArray(map))
    throw new Error(`"devkit.${key}" in ${pkgPath} is a list — it is now a map of name to settings`);
  return Object.entries(map).map(([name, entry]) => ({ ...entry, name }));
}

/**
 * The platforms asked for, plus whatever they depend on — a step can't run without its needs,
 * and a dev process can't be developed against a stack that isn't up.
 */
export function withNeeds<T extends Step>(entries: Named<T>[], only: string[]): Named<T>[] {
  if (!only.length) return entries;
  const unknown = only.filter((name) => !entries.some((entry) => entry.name === name));
  if (unknown.length) {
    const known = entries.map((entry) => entry.name).join(", ") || "none configured";
    throw new Error(`Unknown platform${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (have: ${known})`);
  }

  const wanted = new Set(only);
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of entries) {
      if (!wanted.has(entry.name)) continue;
      for (const need of entry.needs ?? []) {
        if (!wanted.has(need)) {
          wanted.add(need);
          grew = true;
        }
      }
    }
  }
  return entries.filter((entry) => wanted.has(entry.name));
}
