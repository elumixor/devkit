import { $ } from "bun";
import { accountId, CloudError, log } from "./aws.ts";
import { ensureSecret, readParameter, writeParameter } from "./env.ts";
import { PLATFORM_ALIASES, platform, STAGE_BRANCHES } from "./names.ts";
import { ensureCertificate } from "./reconcile/acm.ts";
import { ensureRecord } from "./reconcile/cloudflare.ts";
import { findDistribution, reconcileAliases, waitDeployed } from "./reconcile/edge.ts";
import { ensureAnomalyAlerts, ensureBudgets } from "./reconcile/guardrails.ts";
import { ensureDeployRole, ensureLocalDeployProfile, ensureSchedulerRole, GITHUB_OWNERS } from "./reconcile/iam.ts";
import { putEdgeSecret } from "./reconcile/kvs.ts";
import {
  allowDistribution,
  createDistribution,
  ensureBucket,
  ensureCachePolicy,
  ensureKeyValueStore,
  ensureOriginAccessControl,
  ensureRouterAssociations,
  ensureRouterFunction,
} from "./reconcile/platform.ts";
import { buckets } from "./reconcile/s3.ts";
import { ensureScheduleGroup } from "./reconcile/scheduler.ts";

export interface BootstrapOptions {
  /** Where budget and anomaly alerts go (default: `git config user.email`). */
  email?: string;
}

/**
 * Everything the account needs once, in the order each piece needs the last: buckets, the edge
 * (OAC, cache policy, route store, router, certificate, distribution), DNS, the roles and the
 * cost guardrails. Every step reads first, so running it again changes nothing that already matches.
 */
export async function bootstrap(options: BootstrapOptions = {}) {
  const account = await accountId();
  const email = options.email ?? (await $`git config user.email`.quiet().nothrow().text()).trim();
  if (!email) throw new CloudError("No email for alerts: pass --email or set git config user.email");
  log(`Bootstrapping Devkit Cloud in account ${account}\n`);

  log("secrets");
  const edgeSecret = await ensureSecret(platform.edgeSecretParameter);
  await storeCloudflareToken();

  log("\nbuckets");
  const { sites, blobs } = await buckets();
  await Promise.all([ensureBucket(sites), ensureBucket(blobs, { browserUploads: true })]);

  log("\nedge");
  const [oacId, cachePolicyId, kvsArn] = await Promise.all([
    ensureOriginAccessControl(),
    ensureCachePolicy(),
    ensureKeyValueStore(),
  ]);
  await putEdgeSecret(edgeSecret);
  const routerArn = await ensureRouterFunction(kvsArn);
  const certificateArn = await ensureCertificate(PLATFORM_ALIASES);
  const existing = await findDistribution();
  const distribution = existing
    ? await reconcileAliases([])
    : await createDistribution({
        sitesBucket: sites,
        blobsBucket: blobs,
        oacId,
        cachePolicyId,
        routerArn,
        certificateArn,
      });
  const associations = existing ? await ensureRouterAssociations(distribution.id, routerArn) : { changed: false };
  await Promise.all([
    allowDistribution(sites, distribution.arn, "*"),
    allowDistribution(blobs, distribution.arn, "*/*/public/*"),
  ]);

  log("\ndns");
  for (const name of PLATFORM_ALIASES)
    log(`  ${name} → ${distribution.domainName} ${await ensureRecord(name, "CNAME", distribution.domainName)}`);

  log("\naccess");
  await ensureScheduleGroup();
  const scheduler = await ensureSchedulerRole();
  const deploy = await ensureDeployRole(Object.values(STAGE_BRANCHES));
  const local = await ensureLocalDeployProfile();
  log(`  role ${platform.schedulerRole} ${scheduler.created ? "created" : "ok"}`);
  log(
    `  role ${platform.deployRole} ${deploy.created ? "created" : "ok"} (GitHub OIDC, ${GITHUB_OWNERS.map((owner) => `${owner.name}/*`).join(", ")} on ${Object.values(STAGE_BRANCHES).join(", ")})`,
  );
  log(`  profile ${platform.localProfile} ${local.profile} (user ${platform.localDeployUser})`);

  log("\nguardrails");
  await ensureBudgets(email);
  await ensureAnomalyAlerts(email);

  if (!existing || associations.changed) {
    log("\nwaiting for the distribution to deploy (10–15 minutes the first time)");
    await waitDeployed(distribution.id);
  }

  log(
    `\nReady. Distribution ${distribution.id} at ${distribution.domainName}; deploy role arn:aws:iam::${account}:role/${platform.deployRole}`,
  );
}

/** The Cloudflare token comes from the environment on the first run and lives in SSM after that. */
async function storeCloudflareToken() {
  const fromEnv = process.env.CLOUDFLARE_API_TOKEN;
  const stored = await readParameter(platform.cloudflareTokenParameter);
  if (fromEnv && fromEnv !== stored) {
    await writeParameter(platform.cloudflareTokenParameter, fromEnv);
    log(`  stored Cloudflare token at ${platform.cloudflareTokenParameter}`);
    return;
  }
  if (!stored)
    throw new CloudError(
      `No Cloudflare token: run with CLOUDFLARE_API_TOKEN=<token with DNS edit on your zones> once; it is kept at ${platform.cloudflareTokenParameter}`,
    );
}
