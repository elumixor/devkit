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

export interface DevkitConfig {
  apps: DevApp[];
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
