import concurrently from "concurrently";
import { type DevApp, loadConfig } from "./config.ts";
import { freePort } from "./free-port.ts";
import { openUrl, waitForPort } from "./wait-port.ts";

const PALETTE = ["blue", "magenta", "green", "yellow", "cyan", "red"];

/** Turn an app entry into the shell command that runs it. */
function commandFor(app: DevApp): string {
  if (app.command) return app.command;
  const script = app.script ?? "dev";
  if (app.cwd) return `bun --cwd ${app.cwd} run ${script}`;
  return `bun --filter ${app.filter ?? app.name} ${script}`;
}

function labelFor(app: DevApp, index: number): string {
  return app.name ?? app.filter ?? app.cwd ?? `app${index}`;
}

/** Free ports, print URLs, run every app side-by-side, optionally open the browser. */
export async function runDev(open: boolean, dry = false): Promise<void> {
  const { apps } = loadConfig();
  const withPort = apps.filter((app) => app.port != null);

  if (dry) {
    console.log("devkit (dry run):");
    apps.forEach((app, i) => {
      const url = app.port != null ? `  →  http://localhost:${app.port}${app.open ? " (open)" : ""}` : "";
      console.log(`  [${labelFor(app, i)}] ${commandFor(app)}${url}`);
    });
    return;
  }

  await Promise.all(withPort.map((app) => freePort(app.port as number)));

  if (withPort.length > 0) {
    const width = Math.max(...withPort.map((app, i) => labelFor(app, i).length));
    const lines = withPort.map((app, i) => `${labelFor(app, i).padEnd(width)}  http://localhost:${app.port}`);
    console.log(`\n${lines.join("\n")}\n`);
  }

  const { result } = concurrently(
    apps.map((app, i) => ({
      command: commandFor(app),
      name: labelFor(app, i),
      prefixColor: app.color ?? PALETTE[i % PALETTE.length],
    })),
    { prefix: "name", killOthersOn: ["failure", "success"] },
  );

  if (open) {
    for (const app of apps.filter((a) => a.open && a.port != null)) {
      const url = `http://localhost:${app.port}`;
      void waitForPort(app.port as number).then((ready) => {
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
