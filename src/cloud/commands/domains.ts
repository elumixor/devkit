import { bold, dim } from "../../ansi.ts";
import { CloudError, log } from "../aws.ts";
import { deleteRecord } from "../reconcile/cloudflare.ts";
import { needsDns, reconcileAliases } from "../reconcile/edge.ts";
import { deleteRoute, getRoute, putRoutes } from "../reconcile/kvs.ts";
import { readRegistry, updateRegistryHostname } from "../records.ts";
import { targetByName } from "./context.ts";

const USAGE = "usage: devkit cloud domains ls|add|rm <project> [host] [--stage s]";

/** Every hostname each stage of a project answers on, the primary one first. */
export async function listDomains(project: string) {
  const registry = await readRegistry(project);
  if (!registry) throw new CloudError(`No project "${project}" has been deployed`);
  return Object.fromEntries(Object.entries(registry.stages).map(([stage, entry]) => [stage, entry.hostnames]));
}

/**
 * Points one more hostname at a stage without a redeploy: certificate, alias, DNS and route. Later
 * deploys keep it. A hostname in a Cloudflare zone the platform token can edit needs nothing else.
 */
export async function addDomain(project: string, host: string, stageFlag?: string) {
  const { target, recorded } = await targetByName(project, stageFlag);
  const route = await getRoute(recorded.hostnames[0] as string);
  if (!route) throw new CloudError(`No route record for ${recorded.hostnames[0]} — deploy once first`);
  await reconcileAliases([host]);
  await putRoutes({ [host]: route });
  await updateRegistryHostname(target, host, true);
  return `https://${host} now serves ${project} ${target.stage} (new hostnames reach every edge within ~1 min)`;
}

/** Takes a hostname off a stage: route, alias and DNS record. The default hostname stays. */
export async function removeDomain(project: string, host: string, stageFlag?: string) {
  const { target } = await targetByName(project, stageFlag);
  if (host === target.defaultHost) throw new CloudError(`${host} is the stage's default hostname and stays`);
  await deleteRoute(host);
  if (needsDns(host)) {
    await reconcileAliases([], [host]);
    await deleteRecord(host, "CNAME");
  }
  await updateRegistryHostname(target, host, false);
  return `${host} removed from ${project} ${target.stage} (a host listed in the config's \`domains\` returns on the next deploy)`;
}

export async function domains(
  action: string | undefined,
  project: string | undefined,
  host: string | undefined,
  stageFlag: string | undefined,
) {
  if (!project) throw new CloudError(USAGE);
  switch (action) {
    case "ls": {
      log(bold(project));
      for (const [stage, hostnames] of Object.entries(await listDomains(project)))
        log(`  ${stage.padEnd(12)} ${hostnames.map((name, i) => (i ? dim(name) : name)).join("  ")}`);
      return;
    }
    case "add":
      if (!host) throw new CloudError(USAGE);
      return log(await addDomain(project, host, stageFlag));
    case "rm":
      if (!host) throw new CloudError(USAGE);
      return log(await removeDomain(project, host, stageFlag));
    default:
      throw new CloudError(USAGE);
  }
}
