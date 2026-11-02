import { BASE_DOMAIN } from "@elumixor/devkit/cloud";
import { createRemoteJWKSet, jwtVerify } from "jose";

// Who may read the dashboard: a desk Clerk session whose email is on DASHBOARD_EMAILS, or a script
// holding DASHBOARD_TOKEN. Health and the public sign-in config stay open.
const OPEN_PATHS = new Set(["/api/health", "/api/config"]);

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname;
  if (!path.startsWith("/api/") || OPEN_PATHS.has(path)) return;
  const bearer = getHeader(event, "authorization")?.replace(/^Bearer /, "");
  if (!bearer) throw createError({ statusCode: 401, statusMessage: "Sign in first" });
  if (process.env.DASHBOARD_TOKEN && bearer === process.env.DASHBOARD_TOKEN) return;
  const email = await signedInEmail(bearer);
  if (!allowedEmails().includes(email))
    throw createError({ statusCode: 403, statusMessage: `${email} may not open this dashboard` });
});

const allowedEmails = () =>
  (process.env.DASHBOARD_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

/** The Frontend API host a publishable key names: `pk_live_<base64 of "clerk.desk.atmagaming.com$">`. */
const frontendApi = (publishableKey: string) => atob(publishableKey.split("_")[2] ?? "").slice(0, -1);

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
const emails = new Map<string, Promise<string>>();

async function signedInEmail(token: string) {
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!publishableKey || !secretKey)
    throw createError({ statusCode: 503, statusMessage: "CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY not set" });
  const issuer = `https://${frontendApi(publishableKey)}`;
  jwks ??= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  const { payload } = await jwtVerify(token, jwks, { issuer }).catch((error: Error) => {
    throw createError({ statusCode: 401, statusMessage: `Session not accepted: ${error.message}` });
  });
  const party = typeof payload.azp === "string" ? URL.parse(payload.azp)?.hostname : undefined;
  if (!party || (party !== BASE_DOMAIN && !party.endsWith(`.${BASE_DOMAIN}`)))
    throw createError({ statusCode: 401, statusMessage: "Session was made for another site" });
  if (!payload.sub) throw createError({ statusCode: 401, statusMessage: "Session has no user" });
  const sub = payload.sub;
  if (!emails.has(sub)) emails.set(sub, primaryEmail(sub, secretKey));
  return emails.get(sub) as Promise<string>;
}

async function primaryEmail(userId: string, secretKey: string) {
  const response = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
    headers: { authorization: `Bearer ${secretKey}` },
  });
  if (!response.ok) {
    emails.delete(userId);
    throw createError({ statusCode: 502, statusMessage: `Clerk user lookup failed: ${response.status}` });
  }
  const user = (await response.json()) as {
    primary_email_address_id: string;
    email_addresses: { id: string; email_address: string }[];
  };
  const primary = user.email_addresses.find((address) => address.id === user.primary_email_address_id);
  return (primary?.email_address ?? "").toLowerCase();
}
