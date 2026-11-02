import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { accountId, orUndefined, s3 } from "../aws.ts";
import { platform } from "../names.ts";

/** The two buckets, named after the account because bucket names are global. */
export async function buckets() {
  const account = await accountId();
  return { sites: platform.sitesBucket(account), blobs: platform.blobsBucket(account) };
}

export async function getJson<T>(bucket: string, key: string): Promise<T | undefined> {
  const result = await orUndefined(s3().send(new GetObjectCommand({ Bucket: bucket, Key: key })), "NoSuchKey");
  if (!result?.Body) return undefined;
  return JSON.parse(await result.Body.transformToString()) as T;
}

export async function putJson(bucket: string, key: string, value: unknown) {
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(value, null, 2),
      ContentType: "application/json",
    }),
  );
}

/** Every key under a prefix with its ETag — an MD5 for anything uploaded in one part. */
export async function listKeys(bucket: string, prefix: string) {
  const keys = new Map<string, string>();
  let ContinuationToken: string | undefined;
  do {
    const page = await s3().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }));
    for (const item of page.Contents ?? []) if (item.Key) keys.set(item.Key, (item.ETag ?? "").replace(/"/g, ""));
    ContinuationToken = page.NextContinuationToken;
  } while (ContinuationToken);
  return keys;
}

/** The first-level "folders" under a prefix — deploy ids under a project, say. */
export async function listPrefixes(bucket: string, prefix: string) {
  const found: string[] = [];
  let ContinuationToken: string | undefined;
  do {
    const page = await s3().send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: "/", ContinuationToken }),
    );
    for (const item of page.CommonPrefixes ?? []) if (item.Prefix) found.push(item.Prefix);
    ContinuationToken = page.NextContinuationToken;
  } while (ContinuationToken);
  return found;
}

export async function deletePrefix(bucket: string, prefix: string) {
  const keys = [...(await listKeys(bucket, prefix)).keys()];
  for (let i = 0; i < keys.length; i += 1000) {
    await s3().send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
      }),
    );
  }
  return keys.length;
}

/** Fingerprinted asset paths get a year of immutable caching; everything else is revalidated on each visit. */
const IMMUTABLE_PATTERNS = [/^_app\/immutable\//, /^assets\//, /^_next\/static\//];
const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
const CACHE_REVALIDATE = "public, max-age=0, must-revalidate";
const UPLOAD_CONCURRENCY = 16;

export interface UploadSummary {
  uploaded: number;
  copied: number;
  bytes: number;
}

/**
 * Uploads a directory under `prefix`, copying any file whose MD5 matches the previous deploy's
 * server-side rather than sending it again — most of a redeploy's files are unchanged.
 */
export async function uploadDirectory(
  bucket: string,
  dir: string,
  prefix: string,
  previousPrefix: string | undefined,
): Promise<UploadSummary> {
  const files = await walk(dir);
  const previous = previousPrefix ? await listKeys(bucket, previousPrefix) : new Map<string, string>();
  const summary: UploadSummary = { uploaded: 0, copied: 0, bytes: 0 };

  const queue = [...files];
  const worker = async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const path = relative(dir, file).split("\\").join("/");
      const key = prefix + path;
      const body = await Bun.file(file).bytes();
      const md5 = createHash("md5").update(body).digest("hex");
      const twin = previousPrefix ? `${previousPrefix}${path}` : undefined;
      if (twin && previous.get(twin) === md5) {
        await s3().send(
          new CopyObjectCommand({
            Bucket: bucket,
            Key: key,
            CopySource: `/${bucket}/${encodeURIComponent(twin).replace(/%2F/g, "/")}`,
            MetadataDirective: "COPY",
          }),
        );
        summary.copied++;
        continue;
      }
      await s3().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType(file),
          CacheControl: IMMUTABLE_PATTERNS.some((pattern) => pattern.test(path)) ? CACHE_IMMUTABLE : CACHE_REVALIDATE,
        }),
      );
      summary.uploaded++;
      summary.bytes += body.byteLength;
    }
  };
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
  return summary;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return (await stat(path)).isFile() ? [path] : [];
    }),
  );
  return nested.flat();
}

/** Bun knows MIME types by extension; S3 would otherwise serve everything as octet-stream. */
function contentType(file: string) {
  const type = Bun.file(file).type;
  return type && type !== "application/octet-stream" ? type : "application/octet-stream";
}
