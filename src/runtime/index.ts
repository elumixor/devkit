/**
 * `@elumixor/devkit/runtime`: what an app imports to keep working after the response has gone out.
 *
 * On Devkit Cloud the Lambda wrapper registers the collector; on Vercel the request context does.
 * Code can switch its import before the hosting moves.
 */

const DEVKIT_WAIT_UNTIL = Symbol.for("dk.waitUntil");
const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

type WaitUntil = (promise: Promise<unknown>) => void;

interface VercelRequestContext {
  get?: () => { waitUntil?: WaitUntil } | undefined;
}

/**
 * Keeps the invocation alive until `promise` settles, after the client has its response.
 *
 * Outside any host that supports it (local dev, tests) the promise simply runs — nothing waits,
 * which is what a long-lived dev server does anyway.
 */
export function waitUntil(promise: Promise<unknown>): void {
  const scope = globalThis as Record<symbol, unknown>;
  const devkit = scope[DEVKIT_WAIT_UNTIL] as WaitUntil | undefined;
  const vercel = (scope[VERCEL_REQUEST_CONTEXT] as VercelRequestContext | undefined)?.get?.()?.waitUntil;
  const host = devkit ?? vercel;
  if (host) host(promise);
  else promise.catch((error: unknown) => console.error("waitUntil task failed", error));
}

/** The deploy the running code belongs to, for tagging errors and logs. */
export const deployment = {
  get project() {
    return process.env.DK_PROJECT;
  },
  get stage() {
    return process.env.DK_STAGE;
  },
  get id() {
    return process.env.DK_DEPLOY_ID;
  },
  get host() {
    return process.env.DK_HOST;
  },
  /** True when running on Devkit Cloud, as opposed to Vercel or a laptop. */
  get isCloud() {
    return Boolean(process.env.DK_PROJECT);
  },
};
