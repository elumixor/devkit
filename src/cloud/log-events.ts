import { FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CloudError, logs as logsClient } from "./aws.ts";
import type { Target } from "./project.ts";

export interface LogEvent {
  id: string;
  timestamp: number;
  message: string;
}

export interface LogQuery {
  /** Epoch milliseconds to read from. */
  startTime: number;
  /** CloudWatch filter pattern — a word, a phrase in quotes, or `?a ?b`. */
  grep?: string;
  limit?: number;
}

/** One stage's log lines after `startTime`, oldest first. */
export async function fetchLogEvents(target: Target, query: LogQuery): Promise<LogEvent[]> {
  const events: LogEvent[] = [];
  let nextToken: string | undefined;
  try {
    do {
      const result = await logsClient().send(
        new FilterLogEventsCommand({
          logGroupName: target.logGroup,
          startTime: query.startTime,
          filterPattern: query.grep,
          nextToken,
          interleaved: true,
          limit: query.limit,
        }),
      );
      for (const event of result.events ?? []) {
        if (event.eventId && event.timestamp !== undefined)
          events.push({ id: event.eventId, timestamp: event.timestamp, message: (event.message ?? "").trimEnd() });
      }
      nextToken = result.nextToken;
    } while (nextToken && (!query.limit || events.length < query.limit));
  } catch (error) {
    if (error instanceof Error && error.name === "ResourceNotFoundException")
      throw new CloudError(`No log group ${target.logGroup} — has ${target.project} ${target.stage} been deployed?`);
    throw error;
  }
  return events;
}

/** `30m`, `2h`, `1d` → milliseconds. */
export function parseDuration(text: string) {
  const match = /^(\d+)\s*([smhd])$/.exec(text.trim());
  if (!match) throw new CloudError(`a duration wants a number and a unit (30m, 2h, 1d), not "${text}"`);
  const [, amount, unit] = match as unknown as [string, string, "s" | "m" | "h" | "d"];
  const seconds = { s: 1, m: 60, h: 3600, d: 86400 }[unit];
  return Number(amount) * seconds * 1000;
}
