import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { $ } from "bun";
import { AWS_OUTPUT } from "../build-targets/web.ts";
import { CloudError, log, s3 } from "./aws.ts";
import { type Env, ensureSecret, readParameter, readStageEnv } from "./env.ts";
import { startGithubDeployment } from "./github.ts";
import { compileHeaders } from "./headers.ts";
import { EDGE_HEADER, HOST_HEADER, headersKey, stage as names, platform } from "./names.ts";
import type { Target } from "./project.ts";
import { pointDns, reconcileAliases } from "./reconcile/edge.ts";
import { ensureFunctionRole, ensureSchedulerRole } from "./reconcile/iam.ts";
import { keysWithPrefix, type RouteRecord, updateKeys } from "./reconcile/kvs.ts";
import {
  deleteVersion,
  ensureFunctionUrl,
  invokeHttp,
  listVersions,
  liveVersion,
  pointLiveAlias,
  publishFunction,
  urlHost,
} from "./reconcile/lambda.ts";
import { ensureLogGroup } from "./reconcile/logs.ts";
import { buckets, deletePrefix, listPrefixes, uploadDirectory } from "./reconcile/s3.ts";
import { ensureScheduleGroup, reconcileSchedules } from "./reconcile/scheduler.ts";
import {
  type DeployRecord,
  deployHostnames,
  listDeploys,
  readCurrent,
  readDeploy,
  updateRegistry,
  writeCurrent,
  writeDeploy,
} from "./records.ts";

/** How many deploys a stage keeps around for rollback. */
export const KEEP_DEPLOYS = 10;

export interface ReleaseOptions {
  root: string;
  /** Skip the health check — only for the first deploy of a project with no health route yet. */
  skipHealthCheck?: boolean;
}

interface GitInfo {
  sha: string;
  branch: string;
  author: string;
  message: string;
}

/**
 * Takes a finished build live: reconcile the stage's resources, upload, publish a version, prove
 * it answers, then flip the alias and the route records. Nothing points at the new code until the
 * health check has passed, so a broken deploy leaves the old one serving.
 */
export async function release(target: Target, options: ReleaseOptions) {
  const started = Date.now();
  const git = await gitInfo(options.root);
  const deployId = `${timestamp()}-${git.sha.slice(0, 7)}`;
  const staticDir = join(options.root, AWS_OUTPUT, "static");
  const serverDir = join(options.root, AWS_OUTPUT, "server");
  if (!target.isStatic && !existsSync(serverDir))
    throw new CloudError(`No build at ${serverDir} — the web build runs first`);
  if (target.isStatic && target.crons.length) throw new CloudError('"crons" need an API — "apiPrefixes" is empty');
  const headers = compileHeaders(target.headers);

  const { sites, blobs } = await buckets();
  const hostnames = await deployHostnames(target);
  const github = await startGithubDeployment(git.sha, target.stage, `${target.project} ${deployId}`);
  const record: DeployRecord = {
    id: deployId,
    project: target.project,
    stage: target.stage,
    version: "",
    commit: git.sha,
    branch: git.branch,
    author: git.author,
    message: git.message,
    startedAt: new Date(started).toISOString(),
    status: "failed",
    hostnames,
  };

  try {
    log(`Deploying ${target.project} ${target.stage} as ${deployId}`);

    step("reconcile");
    const aliasesChanged = target.domains.length ? (await reconcileAliases(target.domains)).changed : false;
    const edgeSecret = await readParameter(platform.edgeSecretParameter);
    if (!edgeSecret) throw new CloudError("No edge secret in SSM — run `devkit cloud bootstrap`");

    if (target.isStatic) {
      step("upload");
      const previous = await readCurrent(target);
      await uploadStatic(target, staticDir, deployId, previous?.deployId);
      record.version = STATIC_VERSION;

      step("flip");
      const deployPath = `${target.stage}/${deployId}`;
      const route: RouteRecord = {
        p: target.project,
        s: target.stage,
        d: deployPath,
        fn: "",
        api: [],
        mode: target.routing,
      };
      await flipRoutes(target, hostnames, route, headers);
      await pointDns(target.domains, aliasesChanged);

      await finish(target, record, previous?.deployId, "", hostnames, github, sites, started);
      return;
    }

    const [role, schedulerRole] = await Promise.all([ensureFunctionRole(target), ensureSchedulerRole()]);
    await Promise.all([ensureLogGroup(target.logGroup), ensureScheduleGroup()]);

    step("env");
    const stageEnv = await readStageEnv(target);
    if (target.crons.length && !stageEnv.CRON_SECRET) {
      stageEnv.CRON_SECRET = await ensureSecret(`${target.ssmPrefix}CRON_SECRET`);
      log("  made a CRON_SECRET for the stage");
    }
    const env: Env = {
      // What Vercel sets on every deployment, so `NODE_ENV === "production"` checks read the same here.
      NODE_ENV: "production",
      ...stageEnv,
      DK_PROJECT: target.project,
      DK_STAGE: target.stage,
      DK_DEPLOY_ID: deployId,
      DK_HOST: target.primaryHost,
      DK_BLOB_BUCKET: blobs,
      DK_EDGE_SECRET: edgeSecret,
    };

    step("upload");
    const previous = await readCurrent(target);
    await uploadStatic(target, staticDir, deployId, previous?.deployId);

    step("publish");
    const codeKey = names.codeKey(target.project, target.stage, deployId);
    await s3().send(new PutObjectCommand({ Bucket: sites, Key: codeKey, Body: await zip(serverDir) }));
    const { version, created } = await publishFunction(target, {
      roleArn: role.arn,
      code: { bucket: sites, key: codeKey },
      env,
      description: `${deployId} ${git.message.split("\n")[0]}`.slice(0, 256),
    });
    record.version = version;
    log(`  ${created ? "created" : "updated"} ${target.functionName}, version ${version}`);

    // The URL hangs off the `live` alias, so a brand-new function gets its alias now; it has no
    // traffic yet, so nothing is exposed before the health check.
    const live = await liveVersion(target.functionName);
    if (!live) await pointLiveAlias(target.functionName, version);
    const functionUrl = await ensureFunctionUrl(target.functionName);

    if (target.options.predeploy) {
      step("predeploy");
      log(`  ${target.options.predeploy}`);
      await $`sh -c ${target.options.predeploy}`.cwd(options.root).env({ ...process.env, ...stageEnv });
    }

    if (!options.skipHealthCheck) {
      step("health check");
      await healthCheck(target, version, edgeSecret);
    }

    step("flip");
    const alias = await pointLiveAlias(target.functionName, version);
    const route: RouteRecord = {
      p: target.project,
      s: target.stage,
      d: `${target.stage}/${deployId}`,
      fn: urlHost(functionUrl),
      api: target.apiPrefixes,
      mode: target.routing,
    };
    await flipRoutes(target, hostnames, route, headers);
    await pointDns(target.domains, aliasesChanged);
    const schedules = await reconcileSchedules(target, alias.arn, schedulerRole.arn);
    if (schedules.kept || schedules.removed) log(`  ${schedules.kept} schedules, ${schedules.removed} removed`);

    await finish(target, record, previous?.deployId, functionUrl, hostnames, github, sites, started);
  } catch (error) {
    record.finishedAt = new Date().toISOString();
    record.error = error instanceof Error ? error.message : String(error);
    await writeDeploy(record).catch(() => undefined);
    await github.fail();
    throw error;
  }
}

/** What a static deploy records as its version: there is no function to have one. */
export const STATIC_VERSION = "static";

async function uploadStatic(target: Target, staticDir: string, deployId: string, previousId: string | undefined) {
  const { sites } = await buckets();
  const prefix = names.deployPrefix(target.project, target.stage, deployId);
  const previousPrefix = previousId ? names.deployPrefix(target.project, target.stage, previousId) : undefined;
  const uploaded = existsSync(staticDir)
    ? await uploadDirectory(sites, staticDir, prefix, previousPrefix)
    : { uploaded: 0, copied: 0, bytes: 0 };
  log(`  ${uploaded.uploaded} files uploaded (${formatBytes(uploaded.bytes)}), ${uploaded.copied} unchanged`);
}

/** The deploy's headers and every hostname's route in one write: the stage flips at once. */
async function flipRoutes(
  target: Target,
  hostnames: readonly string[],
  route: RouteRecord,
  headers: string | undefined,
) {
  const record = JSON.stringify(headers ? { ...route, h: 1 } : route);
  const puts: Record<string, string> = Object.fromEntries(hostnames.map((host) => [host, record]));
  if (headers) puts[headersKey(target.project, route.d)] = headers;
  await updateKeys(puts);
}

async function finish(
  target: Target,
  record: DeployRecord,
  previousId: string | undefined,
  functionUrl: string,
  hostnames: readonly string[],
  github: Awaited<ReturnType<typeof startGithubDeployment>>,
  sites: string,
  started: number,
) {
  step("record");
  record.status = "live";
  record.finishedAt = new Date().toISOString();
  await Promise.all([
    writeDeploy(record),
    writeCurrent(target, { deployId: record.id, version: record.version, since: record.finishedAt }),
    updateRegistry(target, functionUrl, hostnames),
    previousId ? supersede(target, previousId) : Promise.resolve(),
  ]);
  await github.succeed(`https://${target.primaryHost}`);
  await prune(target, sites);

  const seconds = Math.round((Date.now() - started) / 1000);
  log(`\nLive at https://${target.primaryHost} (${seconds}s)`);
  for (const host of hostnames.slice(1)) log(`        https://${host}`);
}

/** Calls the new version straight through Lambda with the request the edge would make. */
async function healthCheck(target: Target, version: string, edgeSecret: string) {
  const path = target.healthPath;
  const result = await invokeHttp(target.functionName, version, {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: { host: target.primaryHost, accept: "*/*", [EDGE_HEADER]: edgeSecret, [HOST_HEADER]: target.primaryHost },
    requestContext: {
      domainName: target.primaryHost,
      http: { method: "GET", path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "devkit-cloud-health" },
      requestId: "health",
      time: new Date().toUTCString(),
      timeEpoch: Date.now(),
    },
    isBase64Encoded: false,
  });
  if (result.status < 200 || result.status >= 300)
    throw new CloudError(
      `Health check GET ${path} on version ${version} answered ${result.status}: ${result.body.slice(0, 300)}`,
    );
  log(`  GET ${path} → ${result.status}`);
}

async function supersede(target: Target, deployId: string) {
  const previous = await readDeploy(target, deployId);
  if (previous?.status === "live") await writeDeploy({ ...previous, status: "superseded" });
}

/** Keeps the last `KEEP_DEPLOYS` of everything: static prefixes, code zips, function versions and records. */
async function prune(target: Target, sites: string) {
  const deploys = await listDeploys(target, 1000);
  const stale = deploys.slice(KEEP_DEPLOYS);
  const staleVersions = new Set(stale.map((deploy) => deploy.version).filter(Boolean));
  for (const deploy of stale) {
    await deletePrefix(sites, names.deployPrefix(target.project, target.stage, deploy.id));
    await deletePrefix(sites, names.codeKey(target.project, target.stage, deploy.id));
    await deletePrefix(sites, names.deployRecord(target.project, target.stage, deploy.id));
  }
  // Headers of deploys no route can point at again.
  const keptHeaders = new Set(
    deploys.slice(0, KEEP_DEPLOYS).map((deploy) => headersKey(target.project, `${target.stage}/${deploy.id}`)),
  );
  const staleHeaders = (await keysWithPrefix(headersKey(target.project, `${target.stage}/`))).filter(
    (key) => !keptHeaders.has(key),
  );
  if (staleHeaders.length) await updateKeys({}, staleHeaders);
  // Static prefixes with no record — a deploy that died before recording — go too.
  const known = new Set(deploys.slice(0, KEEP_DEPLOYS).map((deploy) => deploy.id));
  for (const prefix of await listPrefixes(sites, names.stagePrefix(target.project, target.stage))) {
    const id = prefix.slice(names.stagePrefix(target.project, target.stage).length, -1);
    if (!known.has(id)) await deletePrefix(sites, prefix);
  }
  if (target.isStatic) {
    if (stale.length) log(`  pruned ${stale.length} old deploys`);
    return;
  }
  const live = await liveVersion(target.functionName);
  for (const version of await listVersions(target.functionName)) {
    if (version !== live && staleVersions.has(version)) await deleteVersion(target.functionName, version);
  }
  if (stale.length) log(`  pruned ${stale.length} old deploys`);
}

async function zip(dir: string) {
  const archive = join(dir, "..", "server.zip");
  await rm(archive, { force: true });
  await $`zip -qry -X ${archive} .`.cwd(dir);
  return Bun.file(archive).bytes();
}

async function gitInfo(root: string): Promise<GitInfo> {
  const read = async (...args: string[]) => (await $`git -C ${root} ${args}`.quiet().nothrow().text()).trim();
  const sha = (await read("rev-parse", "HEAD")) || "0000000";
  return {
    sha,
    branch: process.env.GITHUB_REF_NAME ?? (await read("rev-parse", "--abbrev-ref", "HEAD")) ?? "",
    author: (await read("log", "-1", "--format=%an")) || process.env.GITHUB_ACTOR || "",
    message: (await read("log", "-1", "--format=%s")) || "",
  };
}

const timestamp = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);

function step(name: string) {
  log(`\n${name}`);
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
