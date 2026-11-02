import { DescribeKeyValueStoreCommand as DescribeStore } from "@aws-sdk/client-cloudfront";
import {
  DeleteKeyCommand,
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  ListKeysCommand,
  UpdateKeysCommand,
} from "@aws-sdk/client-cloudfront-keyvaluestore";
import { CloudError, cloudfront, kvs, orUndefined } from "../aws.ts";
import { EDGE_SECRET_KEY, platform } from "../names.ts";
import type { Routing } from "../project.ts";

/**
 * What the router reads for one hostname: which project, stage and deploy to serve, where its
 * function answers, which path prefixes are the API, and how to serve the rest. Kept short — a
 * KVS value may be 1 KB at most.
 */
export interface RouteRecord {
  p: string;
  s: string;
  d: string;
  fn: string;
  api: readonly string[];
  mode: Routing;
}

let storeArn: Promise<string> | undefined;

/** The route store's ARN, looked up by name once per run. */
export function routeStoreArn() {
  storeArn ??= cloudfront()
    .send(new DescribeStore({ Name: platform.kvs }))
    .then((result) => {
      if (!result.KeyValueStore?.ARN) throw new CloudError(`KeyValueStore ${platform.kvs} has no ARN`);
      return result.KeyValueStore.ARN;
    })
    .catch((error: unknown) => {
      if (error instanceof Error && error.name === "EntityNotFound")
        throw new CloudError(`No KeyValueStore ${platform.kvs} — run \`devkit cloud bootstrap\` first`);
      throw error;
    });
  return storeArn;
}

/** Every write needs the store's current ETag, so a batch is read-then-write. */
async function etag(arn: string) {
  const described = await kvs().send(new DescribeKeyValueStoreCommand({ KvsARN: arn }));
  if (!described.ETag) throw new CloudError("KeyValueStore described without an ETag");
  return described.ETag;
}

/** Writes and deletes in one call — the whole stage flips at once, or not at all. */
export async function updateKeys(puts: Record<string, string>, deletes: readonly string[] = []) {
  const arn = await routeStoreArn();
  const Puts = Object.entries(puts).map(([Key, Value]) => ({ Key, Value }));
  const Deletes = deletes.map((Key) => ({ Key }));
  if (!Puts.length && !Deletes.length) return;
  await kvs().send(new UpdateKeysCommand({ KvsARN: arn, IfMatch: await etag(arn), Puts, Deletes }));
}

export async function putRoutes(records: Readonly<Record<string, RouteRecord>>) {
  await updateKeys(Object.fromEntries(Object.entries(records).map(([host, record]) => [host, JSON.stringify(record)])));
}

export async function getRoute(host: string): Promise<RouteRecord | undefined> {
  const result = await orUndefined(
    kvs().send(new GetKeyCommand({ KvsARN: await routeStoreArn(), Key: host })),
    "ResourceNotFoundException",
  );
  return result?.Value ? (JSON.parse(result.Value) as RouteRecord) : undefined;
}

export async function deleteRoute(host: string) {
  const arn = await routeStoreArn();
  await orUndefined(
    kvs().send(new DeleteKeyCommand({ KvsARN: arn, IfMatch: await etag(arn), Key: host })),
    "ResourceNotFoundException",
  );
}

/** Every hostname → record pair in the store, for `status` across projects. */
export async function listRoutes(): Promise<Record<string, RouteRecord>> {
  const arn = await routeStoreArn();
  const routes: Record<string, RouteRecord> = {};
  let NextToken: string | undefined;
  do {
    const page = await kvs().send(new ListKeysCommand({ KvsARN: arn, NextToken }));
    for (const item of page.Items ?? []) {
      if (item.Key && item.Value && item.Key !== EDGE_SECRET_KEY) routes[item.Key] = JSON.parse(item.Value);
    }
    NextToken = page.NextToken;
  } while (NextToken);
  return routes;
}

export async function putEdgeSecret(secret: string) {
  await updateKeys({ [EDGE_SECRET_KEY]: secret });
}
