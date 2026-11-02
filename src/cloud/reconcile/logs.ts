import {
  CreateLogGroupCommand,
  DeleteLogGroupCommand,
  DescribeLogGroupsCommand,
  PutRetentionPolicyCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { logs, orUndefined } from "../aws.ts";

/** Two weeks is long enough to debug last week's incident and short enough to stay inside the free 5 GB. */
export const LOG_RETENTION_DAYS = 14;

/** Makes the log group ahead of the function, so the retention is set before the first line lands. */
export async function ensureLogGroup(name: string) {
  const found = await logs().send(new DescribeLogGroupsCommand({ logGroupNamePrefix: name }));
  const existing = found.logGroups?.find((group) => group.logGroupName === name);
  if (!existing) await logs().send(new CreateLogGroupCommand({ logGroupName: name, tags: { dk: "platform" } }));
  if (existing?.retentionInDays !== LOG_RETENTION_DAYS)
    await logs().send(new PutRetentionPolicyCommand({ logGroupName: name, retentionInDays: LOG_RETENTION_DAYS }));
  return { created: !existing };
}

export async function deleteLogGroup(name: string) {
  await orUndefined(logs().send(new DeleteLogGroupCommand({ logGroupName: name })), "ResourceNotFoundException");
}
