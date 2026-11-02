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
    if (!zone) throw new CloudError(`No Cloudflare zone covers ${hostname} — add the zone or widen the token`);
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
  const found = await call<CloudflareRecord[]>(
    "GET",
    `/zones/${zone}/dns_records?type=${type}&name=${encodeURIComponent(name)}`,
  );
  const existing = found[0];
  const body = { type, name, content, proxied: false, ttl: 300, comment: "devkit cloud" };
  if (!existing) {
    await call("POST", `/zones/${zone}/dns_records`, body);
    return "created";
  }
  if (existing.content.replace(/\.$/, "") === content.replace(/\.$/, "") && !existing.proxied) return "unchanged";
  await call("PUT", `/zones/${zone}/dns_records/${existing.id}`, body);
  return "updated";
}

export async function deleteRecord(name: string, type: "CNAME" | "TXT") {
  const zone = await zoneFor(name);
  const found = await call<CloudflareRecord[]>(
    "GET",
    `/zones/${zone}/dns_records?type=${type}&name=${encodeURIComponent(name)}`,
  );
  for (const record of found) await call("DELETE", `/zones/${zone}/dns_records/${record.id}`);
  return found.length;
}
