import {
  type CertificateSummary,
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  ListCertificatesCommand,
  ListTagsForCertificateCommand,
  RequestCertificateCommand,
} from "@aws-sdk/client-acm";
import { acm, CloudError, log, platformTags, waitFor } from "../aws.ts";
import { ensureRecord } from "./cloudflare.ts";

/**
 * One certificate carries every hostname the distribution answers for (Plan A). A certificate
 * can't gain a name, so adding one means requesting a new certificate and swapping it in.
 */
export async function ensureCertificate(names: readonly string[]): Promise<string> {
  const wanted = [...new Set(names)].sort();
  const issued = await listIssued();
  const covering = issued.find((cert) => wanted.every((name) => cert.names.includes(name)));
  if (covering) return covering.arn;

  log(`  requesting certificate for ${wanted.join(", ")}`);
  const requested = await acm().send(
    new RequestCertificateCommand({
      DomainName: wanted[0],
      SubjectAlternativeNames: wanted.length > 1 ? wanted.slice(1) : undefined,
      ValidationMethod: "DNS",
      KeyAlgorithm: "EC_prime256v1",
      Tags: platformTags(),
    }),
  );
  const arn = requested.CertificateArn;
  if (!arn) throw new CloudError("ACM returned no certificate ARN");

  // Validation records appear a few seconds after the request; each one goes into Cloudflare once.
  const written = new Set<string>();
  await waitFor(
    "certificate validation",
    async () => {
      const described = await acm().send(new DescribeCertificateCommand({ CertificateArn: arn }));
      const cert = described.Certificate;
      if (cert?.Status === "ISSUED") return true;
      if (cert?.Status === "FAILED" || cert?.Status === "VALIDATION_TIMED_OUT")
        throw new CloudError(`Certificate ${arn} ${cert.Status}: ${cert.FailureReason ?? ""}`);
      for (const option of cert?.DomainValidationOptions ?? []) {
        const record = option.ResourceRecord;
        if (!record?.Name || !record.Value || written.has(record.Name)) continue;
        written.add(record.Name);
        const outcome = await ensureRecord(record.Name.replace(/\.$/, ""), "CNAME", record.Value.replace(/\.$/, ""));
        log(`  validation record ${record.Name} ${outcome}`);
      }
      return undefined;
    },
    { everyMs: 10_000, timeoutMs: 15 * 60 * 1000 },
  );
  log("  certificate issued");
  return arn;
}

/** Issued certificates the platform made, with every name they cover. */
export async function listIssued() {
  const summaries: CertificateSummary[] = [];
  let NextToken: string | undefined;
  do {
    // Without the filter ACM lists only RSA certificates, and ours are EC.
    const page = await acm().send(
      new ListCertificatesCommand({
        CertificateStatuses: ["ISSUED"],
        Includes: { keyTypes: ["RSA_2048", "EC_prime256v1", "EC_secp384r1"] },
        NextToken,
      }),
    );
    summaries.push(...(page.CertificateSummaryList ?? []));
    NextToken = page.NextToken;
  } while (NextToken);
  return summaries
    .filter((summary) => summary.CertificateArn)
    .map((summary) => ({
      arn: summary.CertificateArn as string,
      names: [...new Set([summary.DomainName ?? "", ...(summary.SubjectAlternativeNameSummaries ?? [])])].filter(
        Boolean,
      ),
    }));
}

/** Drops certificates no distribution uses — the old one after a swap. ACM refuses while one is in use. */
export async function deleteUnusedCertificates(keepArn: string) {
  for (const cert of await listIssued()) {
    if (cert.arn === keepArn) continue;
    const described = await acm().send(new DescribeCertificateCommand({ CertificateArn: cert.arn }));
    if (described.Certificate?.InUseBy?.length) continue;
    const tags = await acm().send(new ListTagsForCertificateCommand({ CertificateArn: cert.arn }));
    if (!tags.Tags?.some((tag) => tag.Key === "dk")) continue;
    await acm().send(new DeleteCertificateCommand({ CertificateArn: cert.arn }));
    log(`  deleted unused certificate ${cert.names.join(", ")}`);
  }
}
