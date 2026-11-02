import { CloudError, log } from "../aws.ts";
import { deleteStageEnv } from "../env.ts";
import { headersKey, stage as names } from "../names.ts";
import { deleteRecord } from "../reconcile/cloudflare.ts";
import { needsDns, reconcileAliases } from "../reconcile/edge.ts";
import { deleteRole } from "../reconcile/iam.ts";
import { keysWithPrefix, updateKeys } from "../reconcile/kvs.ts";
import { deleteFunction } from "../reconcile/lambda.ts";
import { deleteLogGroup } from "../reconcile/logs.ts";
import { buckets, deletePrefix } from "../reconcile/s3.ts";
import { deleteStageSchedules } from "../reconcile/scheduler.ts";
import { removeRegistryStage } from "../records.ts";
import { targetByName } from "./context.ts";

/** Removes one stage entirely: routes first so nothing serves, then compute, files, env and records. Blobs stay. */
export async function destroy(project: string | undefined, stageFlag: string | undefined) {
  if (!project || !stageFlag) throw new CloudError("usage: devkit cloud destroy <project> --stage <stage>");
  const { target, recorded } = await targetByName(project, stageFlag);
  log(`Destroying ${project} ${target.stage}`);

  await updateKeys({}, [...recorded.hostnames, ...(await keysWithPrefix(headersKey(project, `${target.stage}/`)))]);
  log("  routes removed");
  const custom = recorded.hostnames.filter(needsDns);
  if (custom.length) {
    await reconcileAliases([], custom);
    for (const host of custom) await deleteRecord(host, "CNAME");
    log(`  aliases and DNS removed: ${custom.join(", ")}`);
  }

  await deleteStageSchedules(target);
  await deleteFunction(target.functionName);
  await deleteRole(target.roleName);
  await deleteLogGroup(target.logGroup);
  log("  function, schedules, role and logs removed");

  const { sites } = await buckets();
  const files = await deletePrefix(sites, names.stagePrefix(target.project, target.stage));
  await deletePrefix(sites, `_dk/${target.project}/${target.stage}/`);
  await deleteStageEnv(target);
  await removeRegistryStage(target);
  log(`  ${files} files, deploy records and env removed`);
  log(`Done. Blobs under ${names.blobPrefix(target.project, target.stage)} were left in place.`);
}
