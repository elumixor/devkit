// The KeyValueStore API signs with SigV4A; this side-effect import registers the pure-JS signer so
// the client works under Bun, where the CRT native module does not load.
import "@smithy/signature-v4a";
import { ACMClient } from "@aws-sdk/client-acm";
import { BudgetsClient } from "@aws-sdk/client-budgets";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { CloudFrontKeyValueStoreClient } from "@aws-sdk/client-cloudfront-keyvaluestore";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import { IAMClient } from "@aws-sdk/client-iam";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { SchedulerClient } from "@aws-sdk/client-scheduler";
import { SSMClient } from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { GLOBAL_REGION, REGION } from "./names.ts";

/**
 * One client per service, made on first use. Credentials come from the default chain, so the same
 * code runs with a laptop profile and with the OIDC role GitHub Actions assumes.
 */
function lazy<T>(make: () => T) {
  let instance: T | undefined;
  return () => (instance ??= make());
}

/**
 * A socket that goes quiet for this long is dropped and the call retried: without it a stalled S3
 * request hangs a deploy forever.
 */
const home = {
  region: REGION,
  maxAttempts: 5,
  requestHandler: { connectionTimeout: 10_000, requestTimeout: 120_000 },
};
const edge = { ...home, region: GLOBAL_REGION };

export const lambda = lazy(() => new LambdaClient(home));
export const s3 = lazy(() => new S3Client(home));
export const ssm = lazy(() => new SSMClient(home));
export const iam = lazy(() => new IAMClient(home));
export const logs = lazy(() => new CloudWatchLogsClient(home));
export const cloudwatch = lazy(() => new CloudWatchClient(home));
export const scheduler = lazy(() => new SchedulerClient(home));
export const sts = lazy(() => new STSClient(home));
export const cloudfront = lazy(() => new CloudFrontClient(edge));
export const kvs = lazy(() => new CloudFrontKeyValueStoreClient(edge));
export const acm = lazy(() => new ACMClient(edge));
export const budgets = lazy(() => new BudgetsClient(edge));
export const costExplorer = lazy(() => new CostExplorerClient(edge));

let account: Promise<string> | undefined;

/** The account id, which bucket names and ARNs need; asked of STS once per run. */
export function accountId() {
  account ??= sts()
    .send(new GetCallerIdentityCommand({}))
    .then((identity) => {
      if (!identity.Account) throw new CloudError("STS returned no account id — are AWS credentials configured?");
      return identity.Account;
    });
  return account;
}

/** Anything the platform cannot continue past: a missing resource, a failed check, a bad config. */
export class CloudError extends Error {
  override readonly name = "CloudError";
}

/** AWS SDK errors carry their kind in `name`; this is the only way to tell "missing" from "broken". */
export function isAwsError(error: unknown, ...names: string[]): error is Error {
  return error instanceof Error && names.includes(error.name);
}

/** Resolves with the result, or `undefined` when the call failed with one of the named errors. */
export async function orUndefined<T>(call: Promise<T>, ...names: string[]): Promise<T | undefined> {
  try {
    return await call;
  } catch (error) {
    if (isAwsError(error, ...names)) return undefined;
    throw error;
  }
}

/** Polls `check` until it returns a value, or gives up with a clear message. */
export async function waitFor<T>(
  what: string,
  check: () => Promise<T | undefined>,
  { everyMs = 3000, timeoutMs = 10 * 60 * 1000 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = await check();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new CloudError(`Timed out waiting for ${what}`);
    await Bun.sleep(everyMs);
  }
}

/** Retries a call while it fails with one of the named errors — IAM roles are visible a few seconds after they exist. */
export async function retryWhile<T>(call: () => Promise<T>, names: string[], { times = 10, everyMs = 3000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= times || !isAwsError(error, ...names)) throw error;
      await Bun.sleep(everyMs);
    }
  }
}

/** The `Tags` list most create calls take. */
export const platformTags = (extra: Record<string, string> = {}) =>
  Object.entries({ dk: "platform", ...extra }).map(([Key, Value]) => ({ Key, Value }));

export function log(message: string) {
  console.log(message);
}
