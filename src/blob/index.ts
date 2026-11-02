import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * `@elumixor/devkit/blob`: the part of `@vercel/blob` our apps call, on the platform's blob bucket.
 *
 * Keys are `<project>/<stage>/<access>/<path>`. Public blobs are served through the edge at
 * `https://<host>/_blob/<path>`; private ones only through presigned URLs that expire.
 */

export type Access = "public" | "private";

export interface PutOptions {
  access?: Access;
  contentType?: string;
  cacheControl?: string;
}

export interface Blob {
  pathname: string;
  url: string;
  access: Access;
  size: number;
  uploadedAt: Date;
  contentType?: string;
}

export interface ListOptions {
  prefix?: string;
  access?: Access;
  limit?: number;
  cursor?: string;
}

export interface ListResult {
  blobs: Blob[];
  cursor?: string;
  hasMore: boolean;
}

export class BlobError extends Error {
  override readonly name = "BlobError";
}

const PRESIGN_SECONDS = 15 * 60;
const DEFAULT_ACCESS: Access = "public";

let client: S3Client | undefined;

function settings() {
  const bucket = process.env.DK_BLOB_BUCKET;
  const project = process.env.DK_PROJECT;
  const stage = process.env.DK_STAGE;
  const host = process.env.DK_HOST;
  if (!bucket || !project || !stage || !host)
    throw new BlobError(
      "Blob storage needs DK_BLOB_BUCKET, DK_PROJECT, DK_STAGE and DK_HOST — set by Devkit Cloud at deploy",
    );
  client ??= new S3Client({ region: process.env.AWS_REGION ?? "eu-central-1" });
  return { bucket, prefix: `${project}/${stage}/`, host, client };
}

const normalize = (pathname: string) => pathname.replace(/^\/+/, "");
const keyFor = (prefix: string, access: Access, pathname: string) => `${prefix}${access}/${normalize(pathname)}`;

function urlFor(access: Access, pathname: string): Promise<string> {
  const { bucket, prefix, host, client } = settings();
  if (access === "public") return Promise.resolve(`https://${host}/_blob/${normalize(pathname)}`);
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: keyFor(prefix, access, pathname) }), {
    expiresIn: PRESIGN_SECONDS,
  });
}

/** Stores a blob and returns where it can be read. */
export async function put(
  pathname: string,
  body: string | Uint8Array | ArrayBuffer | ReadableStream,
  options: PutOptions = {},
) {
  const { bucket, prefix, client } = settings();
  const access = options.access ?? DEFAULT_ACCESS;
  const bytes =
    body instanceof ReadableStream
      ? new Uint8Array(await new Response(body).arrayBuffer())
      : body instanceof ArrayBuffer
        ? new Uint8Array(body)
        : body;
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: keyFor(prefix, access, pathname),
      Body: bytes,
      ContentType: options.contentType,
      CacheControl: options.cacheControl ?? (access === "public" ? "public, max-age=31536000, immutable" : undefined),
    }),
  );
  return { pathname: normalize(pathname), url: await urlFor(access, pathname), access };
}

export async function del(pathname: string, access: Access = DEFAULT_ACCESS) {
  const { bucket, prefix, client } = settings();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: keyFor(prefix, access, pathname) }));
}

export async function head(pathname: string, access: Access = DEFAULT_ACCESS): Promise<Blob | undefined> {
  const { bucket, prefix, client } = settings();
  try {
    const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: keyFor(prefix, access, pathname) }));
    return {
      pathname: normalize(pathname),
      url: await urlFor(access, pathname),
      access,
      size: result.ContentLength ?? 0,
      uploadedAt: result.LastModified ?? new Date(0),
      contentType: result.ContentType,
    };
  } catch (error) {
    if (error instanceof Error && (error.name === "NotFound" || error.name === "NoSuchKey")) return undefined;
    throw error;
  }
}

export async function list(options: ListOptions = {}): Promise<ListResult> {
  const { bucket, prefix, client } = settings();
  const access = options.access ?? DEFAULT_ACCESS;
  const scope = `${prefix}${access}/`;
  const page = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: scope + normalize(options.prefix ?? ""),
      MaxKeys: options.limit,
      ContinuationToken: options.cursor,
    }),
  );
  const blobs = await Promise.all(
    (page.Contents ?? [])
      .filter((item) => item.Key)
      .map(async (item) => {
        const pathname = (item.Key as string).slice(scope.length);
        return {
          pathname,
          url: await urlFor(access, pathname),
          access,
          size: item.Size ?? 0,
          uploadedAt: item.LastModified ?? new Date(0),
        } satisfies Blob;
      }),
  );
  return { blobs, cursor: page.NextContinuationToken, hasMore: Boolean(page.IsTruncated) };
}

/** A URL a browser may `PUT` the file to directly, so bodies larger than a function call allows never touch the function. */
export async function createUploadUrl(pathname: string, options: PutOptions = {}) {
  const { bucket, prefix, client } = settings();
  const access = options.access ?? DEFAULT_ACCESS;
  const uploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: bucket, Key: keyFor(prefix, access, pathname), ContentType: options.contentType }),
    { expiresIn: PRESIGN_SECONDS },
  );
  return { uploadUrl, pathname: normalize(pathname), url: await urlFor(access, pathname), access };
}
