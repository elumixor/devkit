import {
  CreateCachePolicyCommand,
  CreateDistributionWithTagsCommand,
  CreateFunctionCommand,
  CreateKeyValueStoreCommand,
  CreateOriginAccessControlCommand,
  DescribeFunctionCommand,
  DescribeKeyValueStoreCommand,
  type DistributionConfig,
  GetDistributionConfigCommand,
  ListCachePoliciesCommand,
  ListOriginAccessControlsCommand,
  PublishFunctionCommand,
  UpdateDistributionCommand,
  UpdateFunctionCommand,
} from "@aws-sdk/client-cloudfront";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketPolicyCommand,
  PutPublicAccessBlockCommand,
} from "@aws-sdk/client-s3";
import { CloudError, cloudfront, log, orUndefined, platformTags, s3, waitFor } from "../aws.ts";
import { ORIGINS, PLATFORM_ALIASES, PROJECT_HEADER, platform, REGION } from "../names.ts";
import { DISTRIBUTION_COMMENT, type Distribution } from "./edge.ts";

/**
 * A private bucket in the home region; nothing in it is reachable except through CloudFront or the SDK.
 * `browserUploads` lets pages PUT to presigned URLs (`createUploadUrl`) from any origin.
 */
export async function ensureBucket(name: string, { browserUploads = false } = {}) {
  const exists = await orUndefined(s3().send(new HeadBucketCommand({ Bucket: name })), "NotFound", "NoSuchBucket");
  if (!exists) {
    await s3().send(
      new CreateBucketCommand({ Bucket: name, CreateBucketConfiguration: { LocationConstraint: REGION } }),
    );
    log(`  created bucket ${name}`);
  }
  await s3().send(
    new PutPublicAccessBlockCommand({
      Bucket: name,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
  await s3().send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: name,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: "abort-incomplete",
            Status: "Enabled",
            Filter: {},
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 },
          },
        ],
      },
    }),
  );
  if (browserUploads)
    await s3().send(
      new PutBucketCorsCommand({
        Bucket: name,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedHeaders: ["*"],
              AllowedMethods: ["PUT", "GET", "HEAD"],
              AllowedOrigins: ["*"],
              ExposeHeaders: ["ETag"],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    );
  return { created: !exists };
}

/** Lets the one distribution read a bucket: everything in the sites bucket, only `public/` blobs. */
export async function allowDistribution(bucket: string, distributionArn: string, objectPattern: string) {
  await s3().send(
    new PutBucketPolicyCommand({
      Bucket: bucket,
      Policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "cloudfront-read",
            Effect: "Allow",
            Principal: { Service: "cloudfront.amazonaws.com" },
            Action: "s3:GetObject",
            Resource: `arn:aws:s3:::${bucket}/${objectPattern}`,
            Condition: { StringEquals: { "AWS:SourceArn": distributionArn } },
          },
          // With list permission a missing file is a 404 rather than a 403, which is what a browser expects.
          {
            Sid: "cloudfront-list",
            Effect: "Allow",
            Principal: { Service: "cloudfront.amazonaws.com" },
            Action: "s3:ListBucket",
            Resource: `arn:aws:s3:::${bucket}`,
            Condition: { StringEquals: { "AWS:SourceArn": distributionArn } },
          },
        ],
      }),
    }),
  );
}

export async function ensureOriginAccessControl() {
  const list = await cloudfront().send(new ListOriginAccessControlsCommand({}));
  const existing = list.OriginAccessControlList?.Items?.find((item) => item.Name === platform.originAccessControl);
  if (existing?.Id) return existing.Id;
  const created = await cloudfront().send(
    new CreateOriginAccessControlCommand({
      OriginAccessControlConfig: {
        Name: platform.originAccessControl,
        OriginAccessControlOriginType: "s3",
        SigningBehavior: "always",
        SigningProtocol: "sigv4",
        Description: "Devkit Cloud: CloudFront reads the sites and blobs buckets",
      },
    }),
  );
  if (!created.OriginAccessControl?.Id) throw new CloudError("CloudFront returned no OAC id");
  log("  created origin access control");
  return created.OriginAccessControl.Id;
}

/**
 * TTLs of zero mean the origin's `Cache-Control` decides: fingerprinted assets say a year, HTML
 * says revalidate, the API says nothing and is never cached. The project header keeps two
 * projects' identical paths apart in the cache.
 */
export async function ensureCachePolicy() {
  const list = await cloudfront().send(new ListCachePoliciesCommand({ Type: "custom" }));
  const existing = list.CachePolicyList?.Items?.find(
    (item) => item.CachePolicy?.CachePolicyConfig?.Name === platform.cachePolicy,
  );
  if (existing?.CachePolicy?.Id) return existing.CachePolicy.Id;
  const created = await cloudfront().send(
    new CreateCachePolicyCommand({
      CachePolicyConfig: {
        Name: platform.cachePolicy,
        Comment: "Devkit Cloud: origin headers decide, keyed by project",
        MinTTL: 0,
        DefaultTTL: 0,
        MaxTTL: 31536000,
        ParametersInCacheKeyAndForwardedToOrigin: {
          EnableAcceptEncodingGzip: true,
          EnableAcceptEncodingBrotli: true,
          HeadersConfig: { HeaderBehavior: "whitelist", Headers: { Quantity: 1, Items: [PROJECT_HEADER] } },
          CookiesConfig: { CookieBehavior: "none" },
          QueryStringsConfig: { QueryStringBehavior: "all" },
        },
      },
    }),
  );
  if (!created.CachePolicy?.Id) throw new CloudError("CloudFront returned no cache policy id");
  log("  created cache policy");
  return created.CachePolicy.Id;
}

export async function ensureKeyValueStore() {
  const existing = await orUndefined(
    cloudfront().send(new DescribeKeyValueStoreCommand({ Name: platform.kvs })),
    "EntityNotFound",
  );
  if (!existing) {
    await cloudfront().send(
      new CreateKeyValueStoreCommand({ Name: platform.kvs, Comment: "Devkit Cloud route records" }),
    );
    log("  created key value store (takes a minute)");
  }
  return waitFor(
    "key value store",
    async () => {
      const described = await cloudfront().send(new DescribeKeyValueStoreCommand({ Name: platform.kvs }));
      return described.KeyValueStore?.Status === "READY" ? (described.KeyValueStore.ARN as string) : undefined;
    },
    { everyMs: 5000 },
  );
}

/** Creates or updates the router from `edge/router.js`, then publishes it to LIVE. */
export async function ensureRouterFunction(kvsArn: string) {
  const code = new TextEncoder().encode(await Bun.file(new URL("../edge/router.js", import.meta.url)).text());
  const config = {
    Comment: "Devkit Cloud router",
    Runtime: "cloudfront-js-2.0" as const,
    KeyValueStoreAssociations: { Quantity: 1, Items: [{ KeyValueStoreARN: kvsArn }] },
  };
  const existing = await orUndefined(
    cloudfront().send(new DescribeFunctionCommand({ Name: platform.routerFunction, Stage: "DEVELOPMENT" })),
    "NoSuchFunctionExists",
  );
  let etag: string | undefined;
  if (!existing) {
    const created = await cloudfront().send(
      new CreateFunctionCommand({ Name: platform.routerFunction, FunctionConfig: config, FunctionCode: code }),
    );
    etag = created.ETag;
    log("  created router function");
  } else {
    const updated = await cloudfront().send(
      new UpdateFunctionCommand({
        Name: platform.routerFunction,
        IfMatch: existing.ETag,
        FunctionConfig: config,
        FunctionCode: code,
      }),
    );
    etag = updated.ETag;
    log("  updated router function");
  }
  const published = await cloudfront().send(
    new PublishFunctionCommand({ Name: platform.routerFunction, IfMatch: etag }),
  );
  const arn = published.FunctionSummary?.FunctionMetadata?.FunctionARN;
  if (!arn) throw new CloudError("CloudFront published the router without an ARN");
  return arn;
}

export interface DistributionInputs {
  sitesBucket: string;
  blobsBucket: string;
  oacId: string;
  cachePolicyId: string;
  routerArn: string;
  certificateArn: string;
}

export function distributionConfig(inputs: DistributionInputs): DistributionConfig {
  const s3Origin = (id: string, bucket: string) => ({
    Id: id,
    DomainName: `${bucket}.s3.${REGION}.amazonaws.com`,
    OriginAccessControlId: inputs.oacId,
    S3OriginConfig: { OriginAccessIdentity: "" },
    OriginPath: "",
    CustomHeaders: { Quantity: 0 },
    ConnectionAttempts: 3,
    ConnectionTimeout: 10,
  });
  return {
    CallerReference: DISTRIBUTION_COMMENT,
    Comment: DISTRIBUTION_COMMENT,
    Enabled: true,
    HttpVersion: "http2and3",
    IsIPV6Enabled: true,
    PriceClass: "PriceClass_100",
    Aliases: { Quantity: PLATFORM_ALIASES.length, Items: [...PLATFORM_ALIASES] },
    ViewerCertificate: {
      ACMCertificateArn: inputs.certificateArn,
      SSLSupportMethod: "sni-only",
      MinimumProtocolVersion: "TLSv1.2_2021",
      CloudFrontDefaultCertificate: false,
    },
    Origins: {
      Quantity: 2,
      Items: [s3Origin(ORIGINS.sites, inputs.sitesBucket), s3Origin(ORIGINS.blobs, inputs.blobsBucket)],
    },
    DefaultCacheBehavior: {
      TargetOriginId: ORIGINS.sites,
      ViewerProtocolPolicy: "redirect-to-https",
      AllowedMethods: {
        Quantity: 7,
        Items: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
        CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
      },
      Compress: true,
      CachePolicyId: inputs.cachePolicyId,
      OriginRequestPolicyId: platform.originRequestPolicyId,
      FunctionAssociations: routerAssociations(inputs.routerArn),
    },
    DefaultRootObject: "",
    Restrictions: { GeoRestriction: { RestrictionType: "none", Quantity: 0 } },
  };
}

export async function createDistribution(inputs: DistributionInputs): Promise<Distribution> {
  const created = await cloudfront().send(
    new CreateDistributionWithTagsCommand({
      DistributionConfigWithTags: { DistributionConfig: distributionConfig(inputs), Tags: { Items: platformTags() } },
    }),
  );
  const distribution = created.Distribution;
  if (!distribution?.Id || !distribution.ARN || !distribution.DomainName)
    throw new CloudError("CloudFront created a distribution without an id");
  log(`  created distribution ${distribution.Id} (${distribution.DomainName})`);
  return {
    id: distribution.Id,
    arn: distribution.ARN,
    domainName: distribution.DomainName,
    aliases: distribution.DistributionConfig?.Aliases?.Items ?? [],
  };
}

/** The router runs on both viewer events: routing the request, then adding the deploy's response headers. */
function routerAssociations(routerArn: string) {
  return {
    Quantity: 2,
    Items: [
      { EventType: "viewer-request" as const, FunctionARN: routerArn },
      { EventType: "viewer-response" as const, FunctionARN: routerArn },
    ],
  };
}

/** Brings an existing distribution's router associations up to date — one made before response headers existed. */
export async function ensureRouterAssociations(distributionId: string, routerArn: string) {
  const { DistributionConfig: config, ETag } = await cloudfront().send(
    new GetDistributionConfigCommand({ Id: distributionId }),
  );
  if (!config?.DefaultCacheBehavior || !ETag) throw new CloudError("CloudFront returned no distribution config");
  const wanted = routerAssociations(routerArn);
  const current = config.DefaultCacheBehavior.FunctionAssociations?.Items ?? [];
  const same =
    current.length === wanted.Items.length &&
    wanted.Items.every((item) =>
      current.some((have) => have.EventType === item.EventType && have.FunctionARN === item.FunctionARN),
    );
  if (same) return { changed: false };
  await cloudfront().send(
    new UpdateDistributionCommand({
      Id: distributionId,
      IfMatch: ETag,
      DistributionConfig: {
        ...config,
        DefaultCacheBehavior: { ...config.DefaultCacheBehavior, FunctionAssociations: wanted },
      },
    }),
  );
  log("  router on viewer-request and viewer-response");
  return { changed: true };
}
