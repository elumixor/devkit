import { dim } from "../../ansi.ts";
import { fetchLogEvents, parseDuration } from "../log-events.ts";
import { resolveTarget } from "./context.ts";

export interface LogsOptions {
  stage?: string;
  /** How far back to start: `30m`, `2h`, `1d` (default `1h`). */
  since?: string;
  grep?: string;
  follow?: boolean;
}

const FOLLOW_EVERY_MS = 2000;

/** Function logs, oldest first; `--follow` keeps polling for new lines. */
export async function logs(project: string | undefined, options: LogsOptions) {
  const target = await resolveTarget(project, options.stage);
  let startTime = Date.now() - parseDuration(options.since ?? "1h");
  const seen = new Set<string>();

  const page = async () => {
    for (const event of await fetchLogEvents(target, { startTime, grep: options.grep })) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      startTime = Math.max(startTime, event.timestamp);
      console.log(`${dim(new Date(event.timestamp).toISOString())} ${event.message}`);
    }
  };

  await page();
  while (options.follow) {
    await Bun.sleep(FOLLOW_EVERY_MS);
    await page();
  }
}
