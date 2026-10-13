import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Glob } from "bun";
import { PALETTE } from "../ansi.ts";
import type { DevPlatform, DevProcess, Named } from "../config.ts";

/** One line of the dev board: a name, a shell command, and whatever its header row needs. */
export interface ServiceSpec {
  /** What this line is called on screen. */
  readonly label: string;
  readonly command: string;
  readonly color: string;
  readonly port?: number;
  /** With `--open`, open this URL once the port answers. */
  readonly open: boolean;
}

/** Flatten a platform into the processes it runs — a web platform is a client and an API. */
function processesOf(platform: Named<DevPlatform>): (DevProcess & { label: string; platform: string })[] {
  const group = platform.processes;
  if (!group) return [{ ...platform, label: platform.name, platform: platform.name }];
  if (platform.type) throw new Error(`"devkit.dev.${platform.name}" has both a "type" and "processes"`);

  const keys = Object.keys(group);
  if (!keys.length) throw new Error(`"devkit.dev.${platform.name}.processes" is empty`);
  return keys.map((key) => {
    const process = group[key] as DevProcess;
    return {
      ...process,
      // The workspace a bare process runs in is named by its key, not by the platform's.
      filter: process.filter ?? key,
      // A platform that runs one process is that process; several need telling apart.
      label: keys.length === 1 ? platform.name : `${platform.name}:${key}`,
      platform: platform.name,
    };
  });
}

/** Workspace package name to its directory, from the root `package.json` `workspaces` globs. */
function workspaceDirs(): Map<string, string> {
  const root = JSON.parse(readFileSync("package.json", "utf8")) as {
    workspaces?: string[] | { packages?: string[] };
  };
  const patterns = Array.isArray(root.workspaces) ? root.workspaces : (root.workspaces?.packages ?? []);
  const dirs = new Map<string, string>();
  for (const pattern of patterns)
    for (const manifest of new Glob(join(pattern, "package.json")).scanSync({ onlyFiles: true })) {
      const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (name) dirs.set(name, dirname(manifest));
    }
  return dirs;
}

/** Turn a process entry into the shell command that runs it. */
function commandFor(
  process: DevProcess & { label: string; platform: string },
  workspaces: Map<string, string>,
): string {
  // A raw command still honours `cwd` — `bunx tauri dev` means the app's directory, not the root.
  if (process.command)
    return process.cwd ? `sh -c ${JSON.stringify(`cd ${process.cwd} && ${process.command}`)}` : process.command;
  // A built-in dev target runs through `devkit _run dev`, which looks its options back up from
  // this same config — the same trick the build and deploy graphs use.
  if (process.type) return `devkit _run dev ${JSON.stringify(process.platform)}`;
  const script = process.script ?? "dev";
  // `bun --filter` would prefix every line with the package name and add its own exit banner, so a
  // filter naming one workspace runs straight in that workspace's directory instead.
  const filter = process.filter ?? process.label;
  const cwd = process.cwd ?? workspaces.get(filter);
  if (cwd) return `bun run --cwd ${cwd} ${script}`;
  return `bun --filter ${filter} ${script}`;
}

export function servicesOf(platforms: Named<DevPlatform>[]): ServiceSpec[] {
  const workspaces = workspaceDirs();
  return platforms.flatMap(processesOf).map((process, i) => ({
    label: process.label,
    command: commandFor(process, workspaces),
    color: process.color ?? (PALETTE[i % PALETTE.length] as string),
    port: process.port,
    open: Boolean(process.open),
  }));
}

export const urlOf = (spec: ServiceSpec) => (spec.port != null ? `http://localhost:${spec.port}` : undefined);
