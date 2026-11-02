import { stage as names, registryKey } from "./names.ts";
import type { Target } from "./project.ts";
import { buckets, getJson, listKeys, putJson } from "./reconcile/s3.ts";

/** What one deploy was and how it ended; the history `deploys`, `status` and `rollback` read. */
export interface DeployRecord {
  id: string;
  project: string;
  stage: string;
  version: string;
  commit: string;
  branch: string;
  author: string;
  message: string;
  startedAt: string;
  finishedAt?: string;
  status: "live" | "superseded" | "failed" | "rolled-back";
  hostnames: readonly string[];
  error?: string;
}

/** The pointer the live stage follows. */
export interface CurrentPointer {
  deployId: string;
  version: string;
  since: string;
}

/** One project's stages as last deployed — what `status` lists without reading every record. */
export interface ProjectRegistry {
  project: string;
  stages: Record<
    string,
    { functionName: string; functionUrl: string; hostnames: readonly string[]; updatedAt: string }
  >;
}

export async function readCurrent(target: Target) {
  return getJson<CurrentPointer>((await buckets()).sites, names.current(target.project, target.stage));
}

export async function writeCurrent(target: Target, pointer: CurrentPointer) {
  await putJson((await buckets()).sites, names.current(target.project, target.stage), pointer);
}

export async function readDeploy(target: Target, deployId: string) {
  return getJson<DeployRecord>((await buckets()).sites, names.deployRecord(target.project, target.stage, deployId));
}

export async function writeDeploy(record: DeployRecord) {
  await putJson((await buckets()).sites, names.deployRecord(record.project, record.stage, record.id), record);
}

/** Deploys newest first — ids start with a timestamp, so key order is time order. */
export async function listDeploys(target: Target, limit = 10): Promise<DeployRecord[]> {
  const { sites } = await buckets();
  const keys = [...(await listKeys(sites, names.deploysPrefix(target.project, target.stage))).keys()].sort().reverse();
  const records = await Promise.all(keys.slice(0, limit).map((key) => getJson<DeployRecord>(sites, key)));
  return records.filter((record): record is DeployRecord => record !== undefined);
}

export async function readRegistry(project: string) {
  return getJson<ProjectRegistry>((await buckets()).sites, registryKey(project));
}

export async function updateRegistry(target: Target, functionUrl: string) {
  const registry = (await readRegistry(target.project)) ?? { project: target.project, stages: {} };
  await putJson((await buckets()).sites, registryKey(target.project), {
    ...registry,
    stages: {
      ...registry.stages,
      [target.stage]: {
        functionName: target.functionName,
        functionUrl,
        hostnames: target.hostnames,
        updatedAt: new Date().toISOString(),
      },
    },
  } satisfies ProjectRegistry);
}

export async function removeRegistryStage(target: Target) {
  const registry = await readRegistry(target.project);
  if (!registry) return;
  const { [target.stage]: _, ...stages } = registry.stages;
  await putJson((await buckets()).sites, registryKey(target.project), { ...registry, stages });
}

export async function listProjects() {
  const { sites } = await buckets();
  const keys = [...(await listKeys(sites, "_dk/projects/")).keys()];
  const registries = await Promise.all(keys.map((key) => getJson<ProjectRegistry>(sites, key)));
  return registries.filter((registry): registry is ProjectRegistry => registry !== undefined);
}

/** Hostnames changed outside a deploy, by `devkit cloud domains`. */
export async function updateRegistryHostnames(target: Target, hostnames: readonly string[]) {
  const registry = await readRegistry(target.project);
  const entry = registry?.stages[target.stage];
  if (!registry || !entry) return;
  await putJson((await buckets()).sites, registryKey(target.project), {
    ...registry,
    stages: { ...registry.stages, [target.stage]: { ...entry, hostnames, updatedAt: new Date().toISOString() } },
  } satisfies ProjectRegistry);
}
