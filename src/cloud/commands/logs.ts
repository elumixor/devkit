import { FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { dim } from "../../ansi.ts";
import { CloudError, logs as logsClient } from "../aws.ts";
import { resolveTarget } from "./context.ts";

export interface LogsOptions {
  stage?: string;
  /** How far back to start: `30m`, `2h`, `1d` (default `1h`). */
  since?: string;
  /** CloudWatch filter pattern — a word, a phrase in quotes, or `?a ?b`. */
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
    let nextToken: string | undefined;
    do {
      const result = await logsClient().send(
        new FilterLogEventsCommand({
          logGroupName: target.logGroup,
          startTime,
          filterPattern: options.grep,
          nextToken,
          interleaved: true,
        }),
      );
      for (const event of result.events ?? []) {
        if (!event.eventId || seen.has(event.eventId) || !event.timestamp) continue;
        seen.add(event.eventId);
        startTime = Math.max(startTime, event.timestamp);
        console.log(`${dim(new Date(event.timestamp).toISOString())} ${(event.message ?? "").trimEnd()}`);
      }
      nextToken = result.nextToken;
    } while (nextToken);
  };

  try {
    await page();
  } catch (error) {
    if (error instanceof Error && error.name === "ResourceNotFoundException")
      throw new CloudError(`No log group ${target.logGroup} — has ${target.project} ${target.stage} been deployed?`);
    throw error;
  }
  while (options.follow) {
    await Bun.sleep(FOLLOW_EVERY_MS);
    await page();
  }
}

function parseDuration(text: string) {
  const match = /^(\d+)\s*([smhd])$/.exec(text.trim());
  if (!match) throw new CloudError(`--since wants a number and a unit (30m, 2h, 1d), not "${text}"`);
  const [, amount, unit] = match as unknown as [string, string, "s" | "m" | "h" | "d"];
  const seconds = { s: 1, m: 60, h: 3600, d: 86400 }[unit];
  return Number(amount) * seconds * 1000;
}
