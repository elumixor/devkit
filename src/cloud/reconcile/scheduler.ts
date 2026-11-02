import {
  CreateScheduleCommand,
  CreateScheduleGroupCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  GetScheduleGroupCommand,
  ListSchedulesCommand,
  UpdateScheduleCommand,
} from "@aws-sdk/client-scheduler";
import { orUndefined, scheduler } from "../aws.ts";
import { cronSlug, stage as names, platform } from "../names.ts";
import type { Target } from "../project.ts";

/** What a schedule delivers to the function; the runtime wrapper turns it into a `GET` on the path. */
export const cronEvent = (path: string) => ({ dk: "cron", path });

export async function ensureScheduleGroup() {
  const existing = await orUndefined(
    scheduler().send(new GetScheduleGroupCommand({ Name: platform.scheduleGroup })),
    "ResourceNotFoundException",
  );
  if (!existing) await scheduler().send(new CreateScheduleGroupCommand({ Name: platform.scheduleGroup }));
}

/**
 * Vercel's five-field cron in UTC → Scheduler's six-field `cron(...)`. EventBridge wants `?` in
 * whichever day field is unconstrained, and numbers its weekdays 1–7 from Sunday where cron uses 0–6.
 */
export function toScheduleExpression(cron: string) {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron "${cron}" must have five fields`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  if (dayOfWeek === "*") return `cron(${minute} ${hour} ${dayOfMonth} ${month} ? *)`;
  if (dayOfMonth !== "*")
    throw new Error(`Cron "${cron}" sets both a day of month and a day of week, which EventBridge cannot express`);
  const weekday = dayOfWeek.replace(/\d/g, (digit) => String((Number(digit) % 7) + 1));
  return `cron(${minute} ${hour} ? ${month} ${weekday} *)`;
}

/** Makes the stage's schedules match its config: creates, updates, and deletes the ones no longer listed. */
export async function reconcileSchedules(target: Target, aliasArn: string, roleArn: string) {
  const wanted = new Map(
    target.crons.map((cron) => [names.schedule(target.project, target.stage, cronSlug(cron.path)), cron]),
  );
  const existing = await listStageSchedules(target);

  for (const [name, cron] of wanted) {
    const input = {
      Name: name,
      GroupName: platform.scheduleGroup,
      ScheduleExpression: toScheduleExpression(cron.schedule),
      ScheduleExpressionTimezone: "UTC",
      FlexibleTimeWindow: { Mode: "OFF" as const },
      Target: {
        Arn: aliasArn,
        RoleArn: roleArn,
        Input: JSON.stringify(cronEvent(cron.path)),
        RetryPolicy: { MaximumRetryAttempts: 0 },
      },
      Description: `${target.project} ${target.stage}: ${cron.path}`,
    };
    const current = existing.has(name)
      ? await scheduler().send(new GetScheduleCommand({ Name: name, GroupName: platform.scheduleGroup }))
      : undefined;
    if (!current) await scheduler().send(new CreateScheduleCommand(input));
    else if (
      current.ScheduleExpression !== input.ScheduleExpression ||
      current.Target?.Arn !== aliasArn ||
      current.Target?.Input !== input.Target.Input
    )
      await scheduler().send(new UpdateScheduleCommand(input));
  }

  const stale = [...existing].filter((name) => !wanted.has(name));
  for (const name of stale)
    await scheduler().send(new DeleteScheduleCommand({ Name: name, GroupName: platform.scheduleGroup }));
  return { kept: wanted.size, removed: stale.length };
}

export async function deleteStageSchedules(target: Target) {
  for (const name of await listStageSchedules(target))
    await scheduler().send(new DeleteScheduleCommand({ Name: name, GroupName: platform.scheduleGroup }));
}

async function listStageSchedules(target: Target) {
  const found = new Set<string>();
  let NextToken: string | undefined;
  do {
    const page = await scheduler().send(
      new ListSchedulesCommand({
        GroupName: platform.scheduleGroup,
        NamePrefix: names.schedulePrefix(target.project, target.stage),
        NextToken,
      }),
    );
    for (const schedule of page.Schedules ?? []) if (schedule.Name) found.add(schedule.Name);
    NextToken = page.NextToken;
  } while (NextToken);
  return found;
}
