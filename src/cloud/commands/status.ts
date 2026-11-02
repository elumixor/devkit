import { GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { bold, dim, paint } from "../../ansi.ts";
import { cloudwatch, log } from "../aws.ts";
import { Target } from "../project.ts";
import { type DeployRecord, listDeploys, listProjects, readCurrent, readRegistry } from "../records.ts";
import { targetByName } from "./context.ts";

const DAY_SECONDS = 24 * 60 * 60;

interface Metrics {
  calls: number;
  errors: number;
  p95ms: number;
}

/** Live deploy per stage with its age and commit, and the last day's calls, errors and p95 duration. */
export async function status(project: string | undefined) {
  const registries = project ? [await readRegistry(project)].filter((r) => r !== undefined) : await listProjects();
  if (!registries.length) return log(project ? `No project "${project}" has been deployed` : "Nothing deployed yet");

  for (const registry of registries) {
    log(bold(registry.project));
    for (const [stage, recorded] of Object.entries(registry.stages)) {
      const target = new Target(registry.project, stage);
      const [current, metrics] = await Promise.all([readCurrent(target), metricsFor(target.functionName)]);
      const deploys = current ? await listDeploys(target, 1) : [];
      const live = deploys.find((deploy) => deploy.id === current?.deployId) ?? deploys[0];
      const health = metrics.errors ? paint(`${metrics.errors} errors`, "red") : paint("no errors", "green");
      log(
        `  ${stage.padEnd(12)} ${current ? `${current.deployId} ${dim(age(current.since))}` : dim("not deployed")}` +
          `  ${live ? dim(`${live.commit.slice(0, 7)} ${live.message}`) : ""}`,
      );
      log(
        `  ${"".padEnd(12)} https://${recorded.hostnames[0]}  ${metrics.calls} calls · ${health} · p95 ${metrics.p95ms} ms (24 h)`,
      );
    }
    log("");
  }
}

/** The last deploys of one stage, newest first. */
export async function deploys(project: string, stageFlag: string | undefined) {
  const { target } = await targetByName(project, stageFlag);
  const records = await listDeploys(target, 10);
  if (!records.length) return log(`No deploys for ${project} ${target.stage}`);
  log(bold(`${project} ${target.stage}`));
  for (const record of records) log(`  ${line(record)}`);
}

function line(record: DeployRecord) {
  const mark =
    record.status === "live"
      ? paint("● live", "green")
      : record.status === "failed"
        ? paint("✗ failed", "red")
        : dim(record.status === "rolled-back" ? "↩ rolled back" : "  superseded");
  const when = dim(age(record.finishedAt ?? record.startedAt));
  const detail = record.status === "failed" ? paint(record.error?.split("\n")[0] ?? "", "red") : dim(record.message);
  return `${record.id}  ${mark.padEnd(22)} ${when.padEnd(14)} ${record.commit.slice(0, 7)} ${record.author.padEnd(18)} ${detail}`;
}

async function metricsFor(functionName: string): Promise<Metrics> {
  const end = new Date();
  const start = new Date(end.getTime() - DAY_SECONDS * 1000);
  const query = (id: string, metric: string, stat: string) => ({
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: "AWS/Lambda",
        MetricName: metric,
        Dimensions: [{ Name: "FunctionName", Value: functionName }],
      },
      Period: DAY_SECONDS,
      Stat: stat,
    },
  });
  const result = await cloudwatch().send(
    new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      MetricDataQueries: [
        query("calls", "Invocations", "Sum"),
        query("errors", "Errors", "Sum"),
        query("p95", "Duration", "p95"),
      ],
    }),
  );
  const value = (id: string) => result.MetricDataResults?.find((item) => item.Id === id)?.Values?.[0] ?? 0;
  return { calls: value("calls"), errors: value("errors"), p95ms: Math.round(value("p95")) };
}

function age(iso: string) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
