/**
 * Every resource name and tag Devkit Cloud creates, in one place.
 *
 * The CLI keeps no state file: it finds what it made by these names, so a name is a contract.
 * Renaming one orphans whatever carried the old name.
 */

/** Where compute, buckets, parameters and schedules live. */
export const REGION = "eu-central-1";
/** CloudFront, its KeyValueStore and the certificates it accepts are global, which AWS spells `us-east-1`. */
export const GLOBAL_REGION = "us-east-1";

/** The apex every default hostname hangs off. */
export const BASE_DOMAIN = "dk.atmagaming.com";
export const WILDCARD_DOMAIN = `*.${BASE_DOMAIN}`;

/** Stage names and the branches that deploy them, matching today's Vercel setup. */
export const STAGE_BRANCHES: Readonly<Record<string, string>> = { production: "main", development: "develop" };
export const PRODUCTION = "production";

/** Resources that exist once per account. Bucket names are global, so they carry the account id. */
export const platform = {
  sitesBucket: (account: string) => `dk-sites-${account}`,
  blobsBucket: (account: string) => `dk-blobs-${account}`,
  kvs: "dk-routes",
  routerFunction: "dk-router",
  originAccessControl: "dk-s3",
  cachePolicy: "dk-default",
  /** AWS managed `AllViewerExceptHostHeader`: every header, cookie and query string reaches the origin. */
  originRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
  deployRole: "dk-deploy",
  deployPolicy: "dk-deploy",
  localDeployUser: "dk-deploy-local",
  localProfile: "devkit",
  schedulerRole: "dk-scheduler",
  scheduleGroup: "dk",
  ssmPrefix: "/dk/_platform/",
  edgeSecretParameter: "/dk/_platform/EDGE_SECRET",
  cloudflareTokenParameter: "/dk/_platform/CLOUDFLARE_API_TOKEN",
  budgetSmall: "dk-monthly-5",
  budgetLarge: "dk-monthly-20",
  anomalyMonitor: "dk-services",
  tag: { key: "dk", value: "platform" },
} as const;

/** Origin ids inside the one distribution — the router selects them by these names. */
export const ORIGINS = { sites: "sites", blobs: "blobs" } as const;

/** The KVS key whose value is the edge secret, and the header that carries it to the function. */
export const EDGE_SECRET_KEY = "_edge";
export const EDGE_HEADER = "x-dk-edge";
/** The viewer's hostname, carried to the function because the origin request drops `Host`. */
export const HOST_HEADER = "x-dk-host";
/** Set by the router per request so two projects' identical API paths never share a cache entry. */
export const PROJECT_HEADER = "x-dk-project";

/** Resources that exist once per project and stage. */
export const stage = {
  fn: (project: string, stage: string) => `dk-${project}-${stage}`,
  role: (project: string, stage: string) => `dk-${project}-${stage}-role`,
  logGroup: (project: string, stage: string) => `/aws/lambda/dk-${project}-${stage}`,
  schedule: (project: string, stage: string, slug: string) => `dk-${project}-${stage}-${slug}`,
  schedulePrefix: (project: string, stage: string) => `dk-${project}-${stage}-`,
  ssmPrefix: (project: string, stage: string) => `/dk/${project}/${stage}/`,
  defaultHost: (project: string, stage: string) =>
    stage === PRODUCTION ? `${project}.${BASE_DOMAIN}` : `${project}-${shortStage(stage)}.${BASE_DOMAIN}`,
  /** Where one deploy's static files live in the sites bucket; the route record's `d` is the part after the project. */
  deployPrefix: (project: string, stage: string, deployId: string) => `${project}/${stage}/${deployId}/`,
  stagePrefix: (project: string, stage: string) => `${project}/${stage}/`,
  codeKey: (project: string, stage: string, deployId: string) => `_dk/${project}/${stage}/code/${deployId}.zip`,
  deployRecord: (project: string, stage: string, deployId: string) =>
    `_dk/${project}/${stage}/deploys/${deployId}.json`,
  deploysPrefix: (project: string, stage: string) => `_dk/${project}/${stage}/deploys/`,
  current: (project: string, stage: string) => `_dk/${project}/${stage}/current.json`,
  blobPrefix: (project: string, stage: string) => `${project}/${stage}/`,
} as const;

export const registryKey = (project: string) => `_dk/projects/${project}.json`;

/** The Lambda alias every Function URL and schedule is bound to; deploys and rollbacks move it. */
export const LIVE_ALIAS = "live";

/** `development` reads as `-dev` in a hostname; any other stage keeps its name. */
function shortStage(name: string) {
  return name === "development" ? "dev" : name;
}

/** A cron path becomes the tail of its schedule name: `/api/cron/sync-all` → `api-cron-sync-all`. */
export function cronSlug(path: string) {
  return (
    path
      .replace(/^\/+|\/+$/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .toLowerCase() || "root"
  );
}
