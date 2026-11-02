import { CloudError, log } from "../aws.ts";
import { headersKey } from "../names.ts";
import { getRoute, hasKey, putRoutes } from "../reconcile/kvs.ts";
import { pointLiveAlias } from "../reconcile/lambda.ts";
import { listDeploys, readCurrent, readDeploy, writeCurrent, writeDeploy } from "../records.ts";
import { targetByName } from "./context.ts";

/**
 * Moves the alias and the route records to an earlier deploy. No build, no upload: the files and
 * the function version are still there, so this is two writes and takes a few seconds.
 */
export async function rollback(project: string, stageFlag: string | undefined, toDeployId: string | undefined) {
  const { target, recorded } = await targetByName(project, stageFlag);
  const current = await readCurrent(target);
  if (!current) throw new CloudError(`${project} ${target.stage} has never been deployed`);

  const to = toDeployId
    ? await readDeploy(target, toDeployId)
    : (await listDeploys(target, 50)).find(
        (deploy) => deploy.id !== current.deployId && deploy.version && deploy.status !== "failed",
      );
  if (!to)
    throw new CloudError(
      toDeployId ? `No deploy ${toDeployId} for ${project} ${target.stage}` : "No earlier deploy to roll back to",
    );
  if (!to.version || to.status === "failed")
    throw new CloudError(`Deploy ${to.id} never went live (${to.status}); pick another with \`devkit cloud deploys\``);

  const started = Date.now();
  log(`Rolling ${project} ${target.stage} back from ${current.deployId} to ${to.id} (${to.message})`);

  const route = await getRoute(recorded.hostnames[0] as string);
  if (!route) throw new CloudError(`No route record for ${recorded.hostnames[0]} — deploy once before rolling back`);
  // A static site has no function, so its route names none.
  if (route.fn) await pointLiveAlias(target.functionName, to.version);
  const d = `${target.stage}/${to.id}`;
  const { h: _, ...rest } = route;
  const moved = (await hasKey(headersKey(project, d))) ? { ...rest, d, h: 1 as const } : { ...rest, d };
  await putRoutes(Object.fromEntries(recorded.hostnames.map((host) => [host, moved])));

  const now = new Date().toISOString();
  const was = await readDeploy(target, current.deployId);
  await Promise.all([
    writeCurrent(target, { deployId: to.id, version: to.version, since: now }),
    writeDeploy({ ...to, status: "live" }),
    was ? writeDeploy({ ...was, status: "rolled-back" }) : Promise.resolve(),
  ]);
  const seconds = Math.round((Date.now() - started) / 1000);
  log(`Live again at https://${recorded.hostnames[0]} (${seconds}s)`);
  return {
    project,
    stage: target.stage,
    from: current.deployId,
    to: to.id,
    url: `https://${recorded.hostnames[0]}`,
    seconds,
  };
}
