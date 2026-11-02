import { join, resolve } from "node:path";
import { AWS_OUTPUT, buildWeb } from "../build-targets/web.ts";
import { readStageEnv } from "../cloud/env.ts";
import { assertNoLocalEnvInBuild } from "../cloud/env-leak.ts";
import { STAGE_BRANCHES } from "../cloud/names.ts";
import { type AwsTargetOptions, projectName, resolveStage, Target } from "../cloud/project.ts";
import { release } from "../cloud/release.ts";

/** How `--stage` reaches a deploy step, which the graph runs as its own process. */
export const STAGE_ENV = "DEVKIT_STAGE";

/**
 * Devkit Cloud: build here, then upload the static files to S3 and the API to Lambda behind the
 * shared CloudFront distribution. The same command runs on a laptop and in GitHub Actions.
 */
export async function deployAws(options: AwsTargetOptions) {
  const root = process.cwd();
  const project = await projectName(options, root);
  const stage = await resolveStage(process.env[STAGE_ENV], options.stages ?? STAGE_BRANCHES, root);
  const target = new Target(project, stage, options);

  // The stage's variables are the build's too, so `VITE_*` values reach the frontend bundle in CI
  // exactly as they do from a laptop's `.env`.
  const stageEnv = await readStageEnv(target);
  Object.assign(process.env, stageEnv);

  await buildWeb({ ...options, host: "aws", static: target.isStatic });
  await assertNoLocalEnvInBuild(
    join(root, AWS_OUTPUT, "static"),
    [root, resolve(root, options.frontendDir ?? "apps/frontend")],
    stageEnv,
  );
  await release(target, { root });
}
