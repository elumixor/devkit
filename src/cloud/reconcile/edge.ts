import {
  type DistributionConfig,
  GetDistributionCommand,
  GetDistributionConfigCommand,
  ListDistributionsCommand,
  UpdateDistributionCommand,
} from "@aws-sdk/client-cloudfront";
import { CloudError, cloudfront, log, waitFor } from "../aws.ts";
import { WILDCARD_DOMAIN } from "../names.ts";
import { deleteUnusedCertificates, ensureCertificate } from "./acm.ts";
import { ensureRecord } from "./cloudflare.ts";

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

/** Default hostnames ride the wildcard alias; anything else must be added to the distribution and its certificate. */
export const needsAlias = (hostname: string) =>
  !hostname.endsWith(WILDCARD_DOMAIN.slice(1)) || hostname.split(".").length !== WILDCARD_DOMAIN.split(".").length;

/**
 * Adds hostnames as aliases, swapping in a certificate that covers them all when the current one
 * doesn't, and points each at the distribution in DNS. Removing works the same way in reverse.
 */
export async function reconcileAliases(add: readonly string[], remove: readonly string[] = []) {
  const distribution = await requireDistribution();
  const { DistributionConfig: config, ETag } = await cloudfront().send(
    new GetDistributionConfigCommand({ Id: distribution.id }),
  );
  if (!config || !ETag) throw new CloudError("CloudFront returned no distribution config");

  const current = config.Aliases?.Items ?? [];
  const wanted = [
    ...new Set([...current.filter((alias) => !remove.includes(alias)), ...add.filter(needsAlias)]),
  ].sort();
  const unchanged = wanted.length === current.length && wanted.every((alias) => current.includes(alias));

  for (const hostname of add.filter(needsAlias)) {
    const outcome = await ensureRecord(hostname, "CNAME", distribution.domainName);
    if (outcome !== "unchanged") log(`  DNS ${hostname} → ${distribution.domainName} ${outcome}`);
  }
  if (unchanged) return distribution;

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
  return { ...distribution, aliases: wanted };
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
