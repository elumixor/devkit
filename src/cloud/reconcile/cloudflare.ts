import { CloudError } from "../aws.ts";
import { readParameter } from "../env.ts";
import { platform } from "../names.ts";

/**
 * The few Cloudflare DNS calls the platform needs, over plain `fetch`. The token lives in SSM and
 * must have DNS edit on every zone a project's domain belongs to.
 */
const API = "https://api.cloudflare.com/client/v4";

interface CloudflareRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

interface Envelope<T> {
  success: boolean;
  result: T;
  errors: { code: number; message: string }[];
}

let tokenPromise: Promise<string> | undefined;

function token() {
  tokenPromise ??= (async () => {
    const fromEnv = process.env.CLOUDFLARE_API_TOKEN;
    if (fromEnv) return fromEnv;
    const stored = await readParameter(platform.cloudflareTokenParameter);
    if (!stored)
      throw new CloudError(
        `No Cloudflare token: set CLOUDFLARE_API_TOKEN or store it at ${platform.cloudflareTokenParameter}`,
      );
    return stored;
  })();
  return tokenPromise;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const envelope = (await response.json()) as Envelope<T>;
  if (!envelope.success) {
    const reasons = envelope.errors.map((error) => `${error.code} ${error.message}`).join("; ");
    throw new CloudError(`Cloudflare ${method} ${path} failed: ${reasons}`);
  }
  return envelope.result;
}

/** The hostname's DNS is hosted elsewhere: its records have to be added at that provider by hand. */
export class ExternalDnsError extends CloudError {}

const zones = new Map<string, Promise<string>>();

/** The zone a hostname belongs to: the longest zone name the token can see that ends the hostname. */
function zoneFor(hostname: string) {
  const apex = hostname.replace(/^\*\./, "");
  const cached = zones.get(apex);
  if (cached) return cached;
  const lookup = (async () => {
    const all = await call<{ id: string; name: string }[]>("GET", "/zones?per_page=200");
    const zone = all
      .filter((candidate) => apex === candidate.name || apex.endsWith(`.${candidate.name}`))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!zone) throw new ExternalDnsError(`No Cloudflare zone covers ${hostname} — add the zone or widen the token`);
    return zone.id;
  })();
  zones.set(apex, lookup);
  return lookup;
}

/**
 * Makes one DNS record exist with this content. Never proxied: CloudFront terminates TLS with its
 * own certificate, and Cloudflare in front of it would hide the viewer from the router.
 */
export async function ensureRecord(name: string, type: "CNAME" | "TXT", content: string) {
  const zone = await zoneFor(name);
  // A CNAME can't sit beside an A or AAAA record, so it takes one over in place (a host moving from
  // another provider's IP): the same record changes type, with no moment the name doesn't resolve.
  const existing =
    (await findRecord(zone, name, type)) ?? (type === "CNAME" ? await findAddress(zone, name) : undefined);
  const body = { type, name, content, proxied: false, ttl: 300, comment: "devkit cloud" };
  if (!existing) {
    await call("POST", `/zones/${zone}/dns_records`, body);
    return "created";
  }
  if (existing.type === type && matches(existing, content)) return "unchanged";
  await call("PUT", `/zones/${zone}/dns_records/${existing.id}`, body);
  if (existing.type !== type) {
    for (const other of await call<CloudflareRecord[]>(
      "GET",
      `/zones/${zone}/dns_records?name=${encodeURIComponent(name)}`,
    ))
      if ((other.type === "A" || other.type === "AAAA") && other.id !== existing.id)
        await call("DELETE", `/zones/${zone}/dns_records/${other.id}`);
    return `replaced ${existing.type}`;
  }
  return "updated";
}

async function findAddress(zone: string, name: string) {
  return (await findRecord(zone, name, "A")) ?? (await findRecord(zone, name, "AAAA"));
}

async function findRecord(zone: string, name: string, type: string) {
  const found = await call<CloudflareRecord[]>(
    "GET",
    `/zones/${zone}/dns_records?type=${type}&name=${encodeURIComponent(name)}`,
  );
  return found[0];
}

const matches = (record: CloudflareRecord, content: string) =>
  record.content.replace(/\.$/, "") === content.replace(/\.$/, "") && !record.proxied;

/** Whether the record already exists with this content, unproxied. */
export async function recordPointsAt(name: string, type: "CNAME" | "TXT", content: string) {
  const existing = await findRecord(await zoneFor(name), name, type);
  return existing !== undefined && matches(existing, content);
}

/** Deletes the record; one at a DNS provider other than Cloudflare is left for its owner to remove. */
export async function deleteRecord(name: string, type: "CNAME" | "TXT") {
  const zone = await zoneFor(name).catch((error: unknown) => {
    if (error instanceof ExternalDnsError) return undefined;
    throw error;
  });
  if (!zone) return 0;
  const found = await call<CloudflareRecord[]>(
    "GET",
    `/zones/${zone}/dns_records?type=${type}&name=${encodeURIComponent(name)}`,
  );
  for (const record of found) await call("DELETE", `/zones/${zone}/dns_records/${record.id}`);
  return found.length;
}
