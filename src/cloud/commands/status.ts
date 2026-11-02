import { bold, dim, paint } from "../../ansi.ts";
import { log } from "../aws.ts";
import { age, overview } from "../overview.ts";
import { type DeployRecord, listDeploys } from "../records.ts";
import { targetByName } from "./context.ts";

/** Live deploy per stage with its age and commit, and the last day's calls, errors and p95 duration. */
export async function status(project: string | undefined) {
  const projects = await overview(project);
  if (!projects.length) return log(project ? `No project "${project}" has been deployed` : "Nothing deployed yet");

  for (const { project: name, stages } of projects) {
    log(bold(name));
    for (const stage of stages) {
      const health = stage.metrics.errors
        ? paint(`${stage.metrics.errors} errors`, "red")
        : paint("no errors", "green");
      const current = stage.current
        ? `${stage.current.deployId} ${dim(age(stage.current.since))}`
        : dim("not deployed");
      const live = stage.live ? dim(`${stage.live.commit.slice(0, 7)} ${stage.live.message}`) : "";
      log(`  ${stage.stage.padEnd(12)} ${current}  ${live}`);
      log(
        `  ${"".padEnd(12)} https://${stage.hostnames[0]}  ${stage.metrics.calls} calls · ${health} · p95 ${stage.metrics.p95ms} ms (24 h)`,
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
