import { GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { cloudwatch } from "./aws.ts";
import { Target } from "./project.ts";
import {
  type CurrentPointer,
  type DeployRecord,
  listDeploys,
  listProjects,
  readCurrent,
  readRegistry,
} from "./records.ts";

const DAY_SECONDS = 24 * 60 * 60;

/** Last day's traffic for one function, from CloudWatch. */
export interface Metrics {
  calls: number;
  errors: number;
  p95ms: number;
}

export interface StageOverview {
  project: string;
  stage: string;
  functionName: string;
  hostnames: readonly string[];
  current?: CurrentPointer;
  live?: DeployRecord;
  metrics: Metrics;
}

export interface ProjectOverview {
  project: string;
  stages: StageOverview[];
}

/** What `status`, the MCP server and the dashboard all show: every stage, what is live on it, how it did today. */
export async function overview(project?: string): Promise<ProjectOverview[]> {
  const registries = project
    ? [await readRegistry(project)].filter((registry) => registry !== undefined)
    : await listProjects();
  return Promise.all(
    registries.map(async (registry) => ({
      project: registry.project,
      stages: await Promise.all(
        Object.entries(registry.stages).map(async ([stage, recorded]) => {
          const target = new Target(registry.project, stage);
          const [current, metrics, deploys] = await Promise.all([
            readCurrent(target),
            metricsFor(target.functionName),
            listDeploys(target, 3),
          ]);
          return {
            project: registry.project,
            stage,
            functionName: target.functionName,
            hostnames: recorded.hostnames,
            current,
            live: deploys.find((deploy) => deploy.id === current?.deployId),
            metrics,
          };
        }),
      ),
    })),
  );
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

/** `3m ago`, `2h ago` — for terminals and the dashboard alike. */
export function age(iso: string) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
