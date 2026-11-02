import {
  type DistributionConfig,
  GetDistributionCommand,
  GetDistributionConfigCommand,
  ListDistributionsCommand,
  UpdateDistributionCommand,
} from "@aws-sdk/client-cloudfront";
import { CloudError, cloudfront, log, waitFor } from "../aws.ts";
import { PLATFORM_ALIASES, WILDCARD_DOMAIN } from "../names.ts";
import { deleteUnusedCertificates, ensureCertificate } from "./acm.ts";
import { ensureRecord, recordPointsAt } from "./cloudflare.ts";

/** How the one distribution is recognised among any others in the account. */
export const DISTRIBUTION_COMMENT = "dk-edge";

export interface Distribution {
  id: string;
  arn: string;
  domainName: string;
  aliases: readonly string[];
}

export async function findDistribution(): Promise<Distribution | undefined> {
  let Marker: string | undefined;
  do {
    const page = await cloudfront().send(new ListDistributionsCommand({ Marker }));
    const found = page.DistributionList?.Items?.find((item) => item.Comment === DISTRIBUTION_COMMENT);
    if (found?.Id && found.ARN && found.DomainName)
      return { id: found.Id, arn: found.ARN, domainName: found.DomainName, aliases: found.Aliases?.Items ?? [] };
    Marker = page.DistributionList?.NextMarker;
  } while (Marker);
  return undefined;
}

export async function requireDistribution() {
  const distribution = await findDistribution();
  if (!distribution) throw new CloudError("No Devkit Cloud distribution — run `devkit cloud bootstrap` first");
  return distribution;
}

export const isWildcard = (hostname: string) => hostname.startsWith("*.");

/** A wildcard alias covers exactly one label under it: `*.desk.example.com` covers `keep.desk.example.com`. */
const covers = (alias: string, hostname: string) =>
  isWildcard(alias) &&
  !isWildcard(hostname) &&
  hostname.endsWith(alias.slice(1)) &&
  hostname.split(".").length === alias.split(".").length;

/** Default hostnames ride the platform's wildcard alias and DNS record; any other hostname needs a DNS record. */
export const needsDns = (hostname: string) => !isWildcard(hostname) && !covers(WILDCARD_DOMAIN, hostname);

/**
 * Adds hostnames as aliases, swapping in a certificate that covers them all when the current one
 * doesn't. DNS is left to `pointDns`, which callers run once the route exists. A hostname a wildcard alias already covers
 * (`*.desk.example.com`, listed in a config's `domains` like any host) takes no alias or certificate
 * name of its own, which keeps the certificate under ACM's name quota. Removing works in reverse.
 */
export async function reconcileAliases(add: readonly string[], remove: readonly string[] = []) {
  const distribution = await requireDistribution();
  const { DistributionConfig: config, ETag } = await cloudfront().send(
    new GetDistributionConfigCommand({ Id: distribution.id }),
  );
  if (!config || !ETag) throw new CloudError("CloudFront returned no distribution config");

  const current = config.Aliases?.Items ?? [];
  const kept = [...PLATFORM_ALIASES, ...current.filter((alias) => !remove.includes(alias)), ...add.filter(isWildcard)];
  const wanted = [
    ...new Set([...kept, ...add.filter((host) => !kept.includes(host) && !kept.some((alias) => covers(alias, host)))]),
  ].sort();
  const unchanged = wanted.length === current.length && wanted.every((alias) => current.includes(alias));

  if (unchanged) return { ...distribution, changed: false };

  const certificateArn = await ensureCertificate(wanted);
  const next: DistributionConfig = {
    ...config,
    Aliases: { Quantity: wanted.length, Items: wanted },
    ViewerCertificate: {
      ACMCertificateArn: certificateArn,
      SSLSupportMethod: "sni-only",
      MinimumProtocolVersion: "TLSv1.2_2021",
      CloudFrontDefaultCertificate: false,
    },
  };
  await cloudfront().send(
    new UpdateDistributionCommand({ Id: distribution.id, IfMatch: ETag, DistributionConfig: next }),
  );
  log(`  distribution aliases → ${wanted.join(", ")}`);
  await deleteUnusedCertificates(certificateArn);
  return { ...distribution, aliases: wanted, changed: true };
}

/** How long a new route record takes to reach every edge's KeyValueStore copy. */
const ROUTE_PROPAGATION_MS = 60_000;

/**
 * Points hostnames at the distribution in DNS — the cut-over step, so it runs last: after the
 * certificate and alias are live on every edge (`aliasesChanged`) and the route records written.
 * A hostname whose record already points here is left alone; for the rest it first waits out the
 * route's propagation, so no viewer is sent to an edge that doesn't know the hostname yet.
 */
export async function pointDns(hostnames: readonly string[], aliasesChanged: boolean) {
  const distribution = await requireDistribution();
  const pending = [];
  for (const hostname of hostnames.filter(needsDns))
    if (!(await recordPointsAt(hostname, "CNAME", distribution.domainName))) pending.push(hostname);
  if (!pending.length) return;
  if (aliasesChanged) await waitDeployed(distribution.id);
  log(`  waiting ${ROUTE_PROPAGATION_MS / 1000}s for routes to reach every edge before DNS`);
  await Bun.sleep(ROUTE_PROPAGATION_MS);
  for (const hostname of pending) {
    const outcome = await ensureRecord(hostname, "CNAME", distribution.domainName);
    log(`  DNS ${hostname} → ${distribution.domainName} ${outcome}`);
  }
}

/** A distribution change takes minutes to reach every edge; most callers don't wait, bootstrap does. */
export async function waitDeployed(id: string) {
  await waitFor(
    "distribution to deploy",
    async () => {
      const result = await cloudfront().send(new GetDistributionCommand({ Id: id }));
      return result.Distribution?.Status === "Deployed" ? true : undefined;
    },
    { everyMs: 15_000, timeoutMs: 20 * 60 * 1000 },
  );
}
