import { basename, resolve } from "node:path";
import { loadConfig, withNeeds } from "./config.ts";
import { printPlain } from "./dev/plain.ts";
import { servicesOf } from "./dev/processes.ts";
import { Supervisor } from "./dev/supervisor.ts";

const LOG_DIR = ".devkit/dev";
const STOP_SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

export interface DevFlags {
  open?: boolean;
  dry?: boolean;
  /** Line-by-line output even on a terminal. */
  plain?: boolean;
}

/**
 * Run the dev processes for the platforms asked for, side by side.
 *
 * `devkit dev` runs every platform; `devkit dev:mac` runs the Mac shell and, because it declares
 * `needs`, the web stack it points at — a native shell with no dev server behind it is a window
 * onto nothing. A person at a terminal gets the board (URLs and states pinned above the log);
 * anything else — an agent's shell, CI, a pipe — gets plain prefixed lines.
 */
export async function runDev(only: string[], flags: DevFlags = {}): Promise<void> {
  const { dev } = loadConfig();
  if (!dev.length) throw new Error('No "devkit.dev" platforms to run');

  for (const platform of dev) {
    const missing = (platform.needs ?? []).filter((need) => !dev.some((other) => other.name === need));
    if (missing.length) throw new Error(`${platform.name} needs unknown platform: ${missing.join(", ")}`);
  }

  const specs = servicesOf(withNeeds(dev, only));

  if (flags.dry) {
    console.log("devkit dev (dry run):");
    for (const spec of specs) {
      const url = spec.port != null ? `  →  http://localhost:${spec.port}${spec.open ? " (open)" : ""}` : "";
      console.log(`  [${spec.label}] ${spec.command}${url}`);
    }
    return;
  }

  const interactive = !flags.plain && Boolean(process.stdout.isTTY && process.stdin.isTTY) && !process.env.CI;
  const supervisor = new Supervisor(specs, {
    color: Boolean(process.stdout.isTTY),
    open: Boolean(flags.open),
    logDir: resolve(process.cwd(), LOG_DIR),
  });

  for (const [signal, code] of Object.entries(STOP_SIGNALS))
    process.once(signal, () => void supervisor.stop().then(() => process.exit(code)));

  if (interactive) {
    const { runBoard } = await import("./dev/board.tsx");
    const board = runBoard(supervisor, basename(process.cwd()));
    await supervisor.start();
    await board;
    console.log(`devkit dev stopped · logs in ${LOG_DIR}`);
    return;
  }

  printPlain(supervisor, Boolean(process.stdout.isTTY));
  await supervisor.start();
  await new Promise<void>((done) => {
    supervisor.subscribe(() => {
      if (supervisor.allEnded) done();
    });
  });
  await supervisor.stop();
  if (supervisor.services.some((service) => service.state === "crashed")) process.exitCode = 1;
}
