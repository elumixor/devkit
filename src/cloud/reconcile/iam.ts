import {
  AttachRolePolicyCommand,
  AttachUserPolicyCommand,
  CreateAccessKeyCommand,
  CreatePolicyCommand,
  CreatePolicyVersionCommand,
  CreateRoleCommand,
  CreateUserCommand,
  DeletePolicyVersionCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetRoleCommand,
  GetUserCommand,
  ListPolicyVersionsCommand,
  ListRolePoliciesCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { $ } from "bun";
import { accountId, iam, orUndefined, platformTags, retryWhile } from "../aws.ts";
import { platform, REGION } from "../names.ts";
import type { Target } from "../project.ts";
import { buckets } from "./s3.ts";

type PolicyDocument = { Version: "2012-10-17"; Statement: readonly Record<string, unknown>[] };

const assumeRole = (service: string): PolicyDocument => ({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole" }],
});

/** Creates the role if missing and makes its one inline policy match; returns the ARN. */
export async function ensureRole(
  name: string,
  trust: PolicyDocument,
  policy: PolicyDocument | undefined,
  description: string,
) {
  const existing = await orUndefined(iam().send(new GetRoleCommand({ RoleName: name })), "NoSuchEntityException");
  const arn =
    existing?.Role?.Arn ??
    (
      await iam().send(
        new CreateRoleCommand({
          RoleName: name,
          AssumeRolePolicyDocument: JSON.stringify(trust),
          Description: description,
          Tags: platformTags(),
        }),
      )
    ).Role?.Arn;
  if (!arn) throw new Error(`IAM returned no ARN for role ${name}`);
  // A role just created is not always visible to the next call yet.
  if (policy)
    await retryWhile(
      () =>
        iam().send(
          new PutRolePolicyCommand({ RoleName: name, PolicyName: name, PolicyDocument: JSON.stringify(policy) }),
        ),
      ["NoSuchEntityException"],
    );
  return { arn, created: !existing };
}

/**
 * A managed policy whose default version is `document`. Inline policies are capped at 2 KB on a
 * user, and the deploy policy is bigger than that, so it is managed and attached to both principals.
 */
export async function ensureManagedPolicy(name: string, document: PolicyDocument) {
  const account = await accountId();
  const arn = `arn:aws:iam::${account}:policy/${name}`;
  const wanted = JSON.stringify(document);
  const existing = await orUndefined(iam().send(new GetPolicyCommand({ PolicyArn: arn })), "NoSuchEntityException");
  if (!existing) {
    await iam().send(new CreatePolicyCommand({ PolicyName: name, PolicyDocument: wanted, Tags: platformTags() }));
    return arn;
  }
  const current = await iam().send(
    new GetPolicyVersionCommand({ PolicyArn: arn, VersionId: existing.Policy?.DefaultVersionId }),
  );
  const currentDocument = decodeURIComponent(current.PolicyVersion?.Document ?? "");
  if (currentDocument && JSON.stringify(JSON.parse(currentDocument)) === wanted) return arn;
  // IAM keeps five versions; the oldest non-default one makes room for the new default.
  const versions = (await iam().send(new ListPolicyVersionsCommand({ PolicyArn: arn }))).Versions ?? [];
  if (versions.length >= 5) {
    const oldest = versions
      .filter((version) => !version.IsDefaultVersion)
      .sort((a, b) => (a.CreateDate?.getTime() ?? 0) - (b.CreateDate?.getTime() ?? 0))[0];
    if (oldest?.VersionId)
      await iam().send(new DeletePolicyVersionCommand({ PolicyArn: arn, VersionId: oldest.VersionId }));
  }
  await iam().send(new CreatePolicyVersionCommand({ PolicyArn: arn, PolicyDocument: wanted, SetAsDefault: true }));
  return arn;
}

export async function deleteRole(name: string) {
  const policies = await orUndefined(
    iam().send(new ListRolePoliciesCommand({ RoleName: name })),
    "NoSuchEntityException",
  );
  if (!policies) return;
  for (const PolicyName of policies.PolicyNames ?? [])
    await iam().send(new DeleteRolePolicyCommand({ RoleName: name, PolicyName }));
  await iam().send(new DeleteRoleCommand({ RoleName: name }));
}

/** A function may write its own logs and touch its own blob prefix — nothing else. */
export async function ensureFunctionRole(target: Target) {
  const account = await accountId();
  const { blobs } = await buckets();
  const prefix = `${target.project}/${target.stage}/`;
  return ensureRole(
    target.roleName,
    assumeRole("lambda.amazonaws.com"),
    {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
          Resource: `arn:aws:logs:${REGION}:${account}:log-group:${target.logGroup}:*`,
        },
        {
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:GetObjectAttributes"],
          Resource: `arn:aws:s3:::${blobs}/${prefix}*`,
        },
        {
          Effect: "Allow",
          Action: "s3:ListBucket",
          Resource: `arn:aws:s3:::${blobs}`,
          Condition: { StringLike: { "s3:prefix": [`${prefix}*`] } },
        },
        ...target.permissions.map((permission) => ({ Effect: "Allow", ...permission })),
      ],
    },
    `Devkit Cloud: ${target.project} ${target.stage} function`,
  );
}

/** EventBridge Scheduler invokes `dk-*` functions through this one role. */
export async function ensureSchedulerRole() {
  const account = await accountId();
  return ensureRole(
    platform.schedulerRole,
    assumeRole("scheduler.amazonaws.com"),
    {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: "lambda:InvokeFunction",
          Resource: `arn:aws:lambda:${REGION}:${account}:function:dk-*`,
        },
      ],
    },
    "Devkit Cloud: lets EventBridge Scheduler call project functions",
  );
}

/**
 * The deploy role: what GitHub Actions assumes through OIDC, and what the local `devkit` profile
 * is limited to. Everything it may touch is named `dk-*` or lives in the platform's buckets.
 */
export async function deployPolicy(): Promise<PolicyDocument> {
  const account = await accountId();
  const { sites, blobs } = await buckets();
  return {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "sts:GetCallerIdentity", Resource: "*" },
      {
        Effect: "Allow",
        Action: ["s3:ListBucket", "s3:GetBucketLocation"],
        Resource: [`arn:aws:s3:::${sites}`, `arn:aws:s3:::${blobs}`],
      },
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource: [`arn:aws:s3:::${sites}/*`, `arn:aws:s3:::${blobs}/*`],
      },
      { Effect: "Allow", Action: "lambda:*", Resource: `arn:aws:lambda:${REGION}:${account}:function:dk-*` },
      { Effect: "Allow", Action: ["lambda:ListFunctions", "lambda:GetAccountSettings"], Resource: "*" },
      {
        Effect: "Allow",
        Action: [
          "iam:GetRole",
          "iam:CreateRole",
          "iam:PutRolePolicy",
          "iam:ListRolePolicies",
          "iam:DeleteRolePolicy",
          "iam:DeleteRole",
          "iam:TagRole",
        ],
        Resource: `arn:aws:iam::${account}:role/dk-*`,
      },
      {
        Effect: "Allow",
        Action: "iam:PassRole",
        Resource: `arn:aws:iam::${account}:role/dk-*`,
        Condition: { StringEquals: { "iam:PassedToService": ["lambda.amazonaws.com", "scheduler.amazonaws.com"] } },
      },
      {
        Effect: "Allow",
        Action: ["logs:CreateLogGroup", "logs:PutRetentionPolicy", "logs:DeleteLogGroup", "logs:TagResource"],
        Resource: `arn:aws:logs:${REGION}:${account}:log-group:/aws/lambda/dk-*`,
      },
      {
        Effect: "Allow",
        Action: [
          "logs:DescribeLogGroups",
          "logs:FilterLogEvents",
          "logs:StartLiveTail",
          "logs:GetLogEvents",
          "logs:DescribeLogStreams",
        ],
        Resource: "*",
      },
      { Effect: "Allow", Action: "cloudwatch:GetMetricData", Resource: "*" },
      {
        Effect: "Allow",
        Action: "scheduler:*",
        Resource: [
          `arn:aws:scheduler:${REGION}:${account}:schedule/${platform.scheduleGroup}/dk-*`,
          `arn:aws:scheduler:${REGION}:${account}:schedule-group/${platform.scheduleGroup}`,
        ],
      },
      { Effect: "Allow", Action: "scheduler:ListSchedules", Resource: "*" },
      {
        Effect: "Allow",
        Action: ["ssm:GetParametersByPath", "ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter"],
        Resource: `arn:aws:ssm:${REGION}:${account}:parameter/dk/*`,
      },
      {
        Effect: "Allow",
        Action: ["cloudfront-keyvaluestore:*"],
        Resource: `arn:aws:cloudfront::${account}:key-value-store/*`,
      },
      {
        Effect: "Allow",
        Action: [
          "cloudfront:DescribeKeyValueStore",
          "cloudfront:ListKeyValueStores",
          "cloudfront:GetDistribution",
          "cloudfront:GetDistributionConfig",
          "cloudfront:UpdateDistribution",
          "cloudfront:ListDistributions",
          "cloudfront:ListTagsForResource",
        ],
        Resource: "*",
      },
      {
        Effect: "Allow",
        Action: [
          "acm:ListCertificates",
          "acm:DescribeCertificate",
          "acm:RequestCertificate",
          "acm:AddTagsToCertificate",
          "acm:ListTagsForCertificate",
          "acm:DeleteCertificate",
        ],
        Resource: "*",
      },
    ],
  };
}

/** elumixor's GitHub account id, which repos made since GitHub's immutable OIDC subjects name instead of a path. */
const GITHUB_OWNER_ID = 12294750;

/**
 * The role GitHub Actions assumes: only `elumixor/*` repos, only on the branches that deploy. Older repos send
 * `repo:elumixor/<repo>:…`, newer ones `repo:elumixor@<owner id>/<repo>@<repo id>:…`.
 */
export async function ensureDeployRole(branches: readonly string[]) {
  const account = await accountId();
  const policyArn = await ensureManagedPolicy(platform.deployPolicy, await deployPolicy());
  const role = await ensureRole(
    platform.deployRole,
    {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Federated: `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com` },
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
            StringLike: {
              "token.actions.githubusercontent.com:sub": branches.flatMap((branch) => [
                `repo:elumixor/*:ref:refs/heads/${branch}`,
                `repo:elumixor@${GITHUB_OWNER_ID}/*:ref:refs/heads/${branch}`,
              ]),
            },
          },
        },
      ],
    },
    undefined,
    "Devkit Cloud: what GitHub Actions deploys with",
  );
  await retryWhile(
    () => iam().send(new AttachRolePolicyCommand({ RoleName: platform.deployRole, PolicyArn: policyArn })),
    ["NoSuchEntityException"],
  );
  return role;
}

/**
 * The scoped `devkit` profile for deploying from a laptop, so the admin key never has to be used
 * for day-to-day deploys. The access key is made once and written straight into the AWS CLI's
 * config; a second run leaves an existing profile alone.
 */
export async function ensureLocalDeployProfile() {
  const user = platform.localDeployUser;
  const existing = await orUndefined(iam().send(new GetUserCommand({ UserName: user })), "NoSuchEntityException");
  if (!existing) await iam().send(new CreateUserCommand({ UserName: user, Tags: platformTags() }));
  const policyArn = await ensureManagedPolicy(platform.deployPolicy, await deployPolicy());
  await retryWhile(
    () => iam().send(new AttachUserPolicyCommand({ UserName: user, PolicyArn: policyArn })),
    ["NoSuchEntityException"],
  );

  const configured = (
    await $`aws configure get aws_access_key_id --profile ${platform.localProfile}`.quiet().nothrow().text()
  ).trim();
  if (configured) return { created: !existing, profile: "kept" as const };

  const key = await iam().send(new CreateAccessKeyCommand({ UserName: user }));
  if (!key.AccessKey?.AccessKeyId || !key.AccessKey.SecretAccessKey) throw new Error("IAM returned no access key");
  await $`aws configure set aws_access_key_id ${key.AccessKey.AccessKeyId} --profile ${platform.localProfile}`.quiet();
  await $`aws configure set aws_secret_access_key ${key.AccessKey.SecretAccessKey} --profile ${platform.localProfile}`.quiet();
  await $`aws configure set region ${REGION} --profile ${platform.localProfile}`.quiet();
  return { created: !existing, profile: "written" as const };
}
