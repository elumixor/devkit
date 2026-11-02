import { loadConfig } from "../../config.ts";
import { CloudError } from "../aws.ts";
import { PRODUCTION, STAGE_BRANCHES } from "../names.ts";
import { type AwsTargetOptions, projectName, resolveStage, Target } from "../project.ts";
import { readRegistry } from "../records.ts";

/** The `aws` deploy step of the repo we are in, or an error that says what to add. */
export function awsOptions(root = process.cwd()): AwsTargetOptions {
  const step = loadConfig(root).deploy.find((entry) => entry.type === "aws");
  if (!step)
    throw new CloudError('No "aws" deploy target in package.json — run `devkit cloud init` or pass the project name');
  return (step.options ?? { apiPrefixes: ["api"] }) as AwsTargetOptions;
}

/**
 * A target for a command run inside a project repo: the config gives the options, the branch the
 * stage. Commands that name a project (`status`, `rollback`) work from anywhere instead.
 */
export async function targetFromRepo(stageFlag: string | undefined, root = process.cwd()) {
  const options = awsOptions(root);
  const stage = await resolveStage(stageFlag, options.stages ?? STAGE_BRANCHES, root);
  return new Target(await projectName(options, root), stage, options);
}

/** A target by name, with whatever the last deploy recorded about it. */
export async function targetByName(project: string, stageFlag: string | undefined) {
  const registry = await readRegistry(project);
  if (!registry) throw new CloudError(`No project "${project}" has been deployed`);
  const stage = stageFlag ?? PRODUCTION;
  const recorded = registry.stages[stage];
  if (!recorded) {
    const known = Object.keys(registry.stages).join(", ") || "none";
    throw new CloudError(`${project} has no stage "${stage}" (deployed: ${known})`);
  }
  return { target: new Target(project, stage), recorded };
}

/** Which target a command means: the project named, else the repo we're in. */
export async function resolveTarget(project: string | undefined, stageFlag: string | undefined) {
  if (project) return (await targetByName(project, stageFlag)).target;
  return targetFromRepo(stageFlag);
}
