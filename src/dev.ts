import concurrently from "concurrently";
import { type DevPlatform, type DevProcess, loadConfig, type Named, withNeeds } from "./config.ts";
import { freePort } from "./free-port.ts";
import { openUrl, waitForPort } from "./wait-port.ts";

const PALETTE = ["blue", "magenta", "green", "yellow", "cyan", "red"];

/** One line of the dev board: a name, a shell command, and whatever the URL banner needs. */
interface Process extends DevProcess {
  /** What this line is called on screen. */
  label: string;
  /** The platform it belongs to — how a built-in target finds its options again. */
  platform: string;
}

/** Flatten a platform into the processes it runs — a web platform is a client and an API. */
function processesOf(platform: Named<DevPlatform>): Process[] {
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

/** Turn a process entry into the shell command that runs it. */
function commandFor(process: Process): string {
  // A raw command still honours `cwd` — `bunx tauri dev` means the app's directory, not the root.
  if (process.command)
    return process.cwd ? `sh -c ${JSON.stringify(`cd ${process.cwd} && ${process.command}`)}` : process.command;
  // A built-in dev target runs through `devkit _run dev`, which looks its options back up from
  // this same config — the same trick the build and deploy graphs use.
  if (process.type) return `devkit _run dev ${JSON.stringify(process.platform)}`;
  const script = process.script ?? "dev";
  if (process.cwd) return `bun run --cwd ${process.cwd} ${script}`;
  return `bun --filter ${process.filter ?? process.label} ${script}`;
}

/**
 * Run the dev processes for the platforms asked for, side by side.
 *
 * `devkit dev` runs every platform; `devkit dev:mac` runs the Mac shell and, because it declares
 * `needs`, the web stack it points at — a native shell with no dev server behind it is a window
 * onto nothing.
 */
export async function runDev(only: string[], flags: { open?: boolean; dry?: boolean } = {}): Promise<void> {
  const { dev } = loadConfig();
  if (!dev.length) throw new Error('No "devkit.dev" platforms to run');

  for (const platform of dev) {
    const missing = (platform.needs ?? []).filter((need) => !dev.some((other) => other.name === need));
    if (missing.length) throw new Error(`${platform.name} needs unknown platform: ${missing.join(", ")}`);
  }

  const processes = withNeeds(dev, only).flatMap(processesOf);
  const withPort = processes.filter((process) => process.port != null);

  if (flags.dry) {
    console.log("devkit dev (dry run):");
    for (const process of processes) {
      const url = process.port != null ? `  →  http://localhost:${process.port}${process.open ? " (open)" : ""}` : "";
      console.log(`  [${process.label}] ${commandFor(process)}${url}`);
    }
    return;
  }

  await Promise.all(withPort.map((process) => freePort(process.port as number)));

  if (withPort.length > 0) {
    const width = Math.max(...withPort.map((process) => process.label.length));
    const lines = withPort.map((p) => `${p.label.padEnd(width)}  http://localhost:${p.port}`);
    console.log(`\n${lines.join("\n")}\n`);
  }

  const { result } = concurrently(
    processes.map((process, i) => ({
      command: commandFor(process),
      name: process.label,
      prefixColor: process.color ?? PALETTE[i % PALETTE.length],
    })),
    { prefix: "name", killOthersOn: ["failure", "success"] },
  );

  if (flags.open) {
    for (const process of processes.filter((p) => p.open && p.port != null)) {
      const url = `http://localhost:${process.port}`;
      void waitForPort(process.port as number).then((ready) => {
        if (ready) void openUrl(url).then(() => console.log(`✓ Opened ${url}`));
      });
    }
  }

  try {
    await result;
  } catch {
    process.exitCode = 1;
  }
}
