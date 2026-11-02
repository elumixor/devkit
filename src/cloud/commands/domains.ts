import { bold, dim } from "../../ansi.ts";
import { CloudError, log } from "../aws.ts";
import { deleteRecord } from "../reconcile/cloudflare.ts";
import { needsAlias, reconcileAliases } from "../reconcile/edge.ts";
import { deleteRoute, getRoute, putRoutes } from "../reconcile/kvs.ts";
import { readRegistry, updateRegistryHostnames } from "../records.ts";
import { targetByName } from "./context.ts";

/**
 * Hostnames outside the config — while a DNS move is in flight, say. `add` wires the certificate,
 * alias, DNS and route; `rm` takes them away. The config's `domains` are applied on every deploy.
 */
export async function domains(
  action: string | undefined,
  project: string | undefined,
  host: string | undefined,
  stageFlag: string | undefined,
) {
  if (!project) throw new CloudError("usage: devkit cloud domains ls|add|rm <project> [host] [--stage s]");
  const { target, recorded } = await targetByName(project, stageFlag);

  switch (action) {
    case "ls": {
      const registry = await readRegistry(project);
      log(bold(project));
      for (const [stage, entry] of Object.entries(registry?.stages ?? {}))
        log(`  ${stage.padEnd(12)} ${entry.hostnames.map((name, i) => (i ? dim(name) : name)).join("  ")}`);
      return;
    }
    case "add": {
      if (!host) throw new CloudError("usage: devkit cloud domains add <project> <host>");
      const route = await getRoute(recorded.hostnames[0] as string);
      if (!route) throw new CloudError(`No route record for ${recorded.hostnames[0]} — deploy once first`);
      await reconcileAliases([host]);
      await putRoutes({ [host]: route });
      await updateRegistryHostnames(target, [host, ...recorded.hostnames.filter((name) => name !== host)]);
      return log(`https://${host} now serves ${project} ${target.stage}`);
    }
    case "rm": {
      if (!host) throw new CloudError("usage: devkit cloud domains rm <project> <host>");
      if (host === target.defaultHost) throw new CloudError(`${host} is the stage's default hostname and stays`);
      await deleteRoute(host);
      if (needsAlias(host)) {
        await reconcileAliases([], [host]);
        await deleteRecord(host, "CNAME");
      }
      await updateRegistryHostnames(
        target,
        recorded.hostnames.filter((name) => name !== host),
      );
      return log(`${host} removed from ${project} ${target.stage}`);
    }
    default:
      throw new CloudError("usage: devkit cloud domains ls|add|rm <project> [host] [--stage s]");
  }
}
