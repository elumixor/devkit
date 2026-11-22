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

/**
 * Creates the role if missing (under `boundary`, a managed policy ARN, when given) and makes its one
 * inline policy match; returns the ARN. Never changes an existing role's trust or boundary.
 */
export async function ensureRole(
  name: string,
  trust: PolicyDocument,
  policy: PolicyDocument | undefined,
  description: string,
  boundary?: string,
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
          PermissionsBoundary: boundary,
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
    boundaryArn(account),
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
    boundaryArn(account),
  );
}

/** The managed policy every function and scheduler role is created under: no role devkit makes can exceed it. */
export const boundaryArn = (account: string) => `arn:aws:iam::${account}:policy/${platform.boundaryPolicy}`;

/**
 * The permissions boundary: the union of what function, dashboard and scheduler roles need. The deploy
 * role may only create or change `dk-*` roles that carry it, so a deploy cannot mint a stronger role.
 */
export function boundaryPolicy(account: string): PolicyDocument {
  const sites = platform.sitesBucket(account);
  const blobs = platform.blobsBucket(account);
  const logGroups = `arn:aws:logs:${REGION}:${account}:log-group:/aws/lambda/dk-*:*`;
  return {
    Version: "2012-10-17",
    Statement: [
      { Sid: "FnLogs", Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: logGroups },
      {
        Sid: "FnBlobs",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:GetObjectAttributes"],
        Resource: `arn:aws:s3:::${blobs}/*`,
      },
      {
        Sid: "FnList",
        Effect: "Allow",
        Action: "s3:ListBucket",
        Resource: [`arn:aws:s3:::${blobs}`, `arn:aws:s3:::${sites}`],
      },
      { Sid: "DashSiteMeta", Effect: "Allow", Action: "s3:GetObject", Resource: `arn:aws:s3:::${sites}/_dk/*` },
      {
        Sid: "SchedulerInvoke",
        Effect: "Allow",
        Action: ["lambda:InvokeFunction", "lambda:GetFunctionConfiguration"],
        Resource: `arn:aws:lambda:${REGION}:${account}:function:dk-*`,
      },
      {
        Sid: "DashReads",
        Effect: "Allow",
        Action: [
          "cloudwatch:GetMetricData",
          "logs:DescribeLogGroups",
          "ce:GetCostAndUsage",
          "ce:GetCostForecast",
          "scheduler:ListSchedules",
          "scheduler:GetSchedule",
          "ssm:DescribeParameters",
        ],
        Resource: "*",
      },
      { Sid: "DashLogs", Effect: "Allow", Action: "logs:FilterLogEvents", Resource: logGroups },
      {
        Sid: "DashDbUrl",
        Effect: "Allow",
        Action: "ssm:GetParameter",
        Resource: `arn:aws:ssm:${REGION}:${account}:parameter/dk/*/*/DATABASE_URL`,
      },
    ],
  };
}

/** Reconciles the boundary policy. Admin only (`devkit cloud bootstrap`); runs before any role is made. */
export async function ensureBoundaryPolicy() {
  return ensureManagedPolicy(platform.boundaryPolicy, boundaryPolicy(await accountId()));
}

/**
 * The deploy role: what GitHub Actions assumes through OIDC, and what the local `devkit` profile
 * is limited to. Everything it may touch is named `dk-*` or lives in the platform's buckets. It may
 * create and change only roles under the boundary, and never the boundary, trusts, managed policies
 * or the deploy roles themselves. Every statement's key order follows the signed plan, so the compact JSON
 * for the platform account equals the plan's document byte for byte.
 */
export function deployPolicy(account: string) {
  const sites = platform.sitesBucket(account);
  const blobs = platform.blobsBucket(account);
  const roles = `arn:aws:iam::${account}:role/dk-*`;
  return {
    Statement: [
      { Action: "sts:GetCallerIdentity", Effect: "Allow", Resource: "*" },
      {
        Action: ["s3:ListBucket", "s3:GetBucketLocation"],
        Effect: "Allow",
        Resource: [`arn:aws:s3:::${sites}`, `arn:aws:s3:::${blobs}`],
      },
      {
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Effect: "Allow",
        Resource: [`arn:aws:s3:::${sites}/*`, `arn:aws:s3:::${blobs}/*`],
      },
      { Action: "lambda:*", Effect: "Allow", Resource: `arn:aws:lambda:${REGION}:${account}:function:dk-*` },
      { Action: ["lambda:ListFunctions", "lambda:GetAccountSettings"], Effect: "Allow", Resource: "*" },
      {
        Sid: "RoleRead",
        Effect: "Allow",
        Action: ["iam:GetRole", "iam:ListRolePolicies", "iam:TagRole", "iam:DeleteRole"],
        Resource: roles,
      },
      {
        Sid: "RoleWriteBoundaryOnly",
        Effect: "Allow",
        Action: ["iam:CreateRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy"],
        Resource: roles,
        Condition: { StringEquals: { "iam:PermissionsBoundary": boundaryArn(account) } },
      },
      {
        Action: "iam:PassRole",
        Condition: { StringEquals: { "iam:PassedToService": ["lambda.amazonaws.com", "scheduler.amazonaws.com"] } },
        Effect: "Allow",
        Resource: roles,
      },
      {
        Action: ["logs:CreateLogGroup", "logs:PutRetentionPolicy", "logs:DeleteLogGroup", "logs:TagResource"],
        Effect: "Allow",
        Resource: `arn:aws:logs:${REGION}:${account}:log-group:/aws/lambda/dk-*`,
      },
      {
        Action: [
          "logs:DescribeLogGroups",
          "logs:FilterLogEvents",
          "logs:StartLiveTail",
          "logs:GetLogEvents",
          "logs:DescribeLogStreams",
        ],
        Effect: "Allow",
        Resource: "*",
      },
      { Action: "cloudwatch:GetMetricData", Effect: "Allow", Resource: "*" },
      {
        Action: "scheduler:*",
        Effect: "Allow",
        Resource: [
          `arn:aws:scheduler:${REGION}:${account}:schedule/${platform.scheduleGroup}/dk-*`,
          `arn:aws:scheduler:${REGION}:${account}:schedule-group/${platform.scheduleGroup}`,
        ],
      },
      { Action: "scheduler:ListSchedules", Effect: "Allow", Resource: "*" },
      {
        Action: ["ssm:GetParametersByPath", "ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter"],
        Effect: "Allow",
        Resource: `arn:aws:ssm:${REGION}:${account}:parameter/dk/*`,
      },
      {
        Action: ["cloudfront-keyvaluestore:*"],
        Effect: "Allow",
        Resource: `arn:aws:cloudfront::${account}:key-value-store/*`,
      },
      {
        Action: [
          "cloudfront:DescribeKeyValueStore",
          "cloudfront:ListKeyValueStores",
          "cloudfront:GetDistribution",
          "cloudfront:GetDistributionConfig",
          "cloudfront:UpdateDistribution",
          "cloudfront:ListDistributions",
          "cloudfront:ListTagsForResource",
        ],
        Effect: "Allow",
        Resource: "*",
      },
      {
        Action: [
          "acm:ListCertificates",
          "acm:DescribeCertificate",
          "acm:RequestCertificate",
          "acm:AddTagsToCertificate",
          "acm:ListTagsForCertificate",
          "acm:DeleteCertificate",
        ],
        Effect: "Allow",
        Resource: "*",
      },
      {
        Sid: "DenyBoundaryChange",
        Effect: "Deny",
        Action: [
          "iam:DeleteRolePermissionsBoundary",
          "iam:PutRolePermissionsBoundary",
          "iam:AttachRolePolicy",
          "iam:DetachRolePolicy",
          "iam:UpdateAssumeRolePolicy",
        ],
        Resource: "*",
      },
      {
        Sid: "DenyPolicyEdit",
        Effect: "Deny",
        Action: [
          "iam:CreatePolicy",
          "iam:CreatePolicyVersion",
          "iam:DeletePolicy",
          "iam:DeletePolicyVersion",
          "iam:SetDefaultPolicyVersion",
        ],
        Resource: "*",
      },
      {
        Sid: "DenyDeployRoleSelf",
        Effect: "Deny",
        Action: ["iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:DeleteRole", "iam:TagRole"],
        Resource: [
          `arn:aws:iam::${account}:role/${platform.deployRole}`,
          `arn:aws:iam::${account}:role/${platform.deployRole}-atmagaming`,
        ],
      },
    ],
    Version: "2012-10-17",
  } satisfies PolicyDocument;
}

/**
 * The repos whose `main` may deploy, by GitHub's immutable OIDC subject
 * `repo:<owner>@<owner id>/<repo>@<repo id>:ref:refs/heads/main`: a renamed or re-created repo
 * or account gets a new id and no access. Adding a repo = adding it here and running bootstrap.
 */
export const DEPLOY_REPOS = [
  { owner: "atmagaming", ownerId: 213760613, repo: "nastu", repoId: 1305267624 },
  { owner: "atmagaming", ownerId: 213760613, repo: "web", repoId: 1154326340 },
  { owner: "elumixor", ownerId: 12294750, repo: "balance", repoId: 1318213485 },
  { owner: "elumixor", ownerId: 12294750, repo: "desk-devkit", repoId: 1443319277 },
  { owner: "elumixor", ownerId: 12294750, repo: "desk-infra", repoId: 1435813666 },
  { owner: "elumixor", ownerId: 12294750, repo: "devkit", repoId: 1294881684 },
  { owner: "elumixor", ownerId: 12294750, repo: "kenoverse", repoId: 1190878121 },
  { owner: "elumixor", ownerId: 12294750, repo: "limn", repoId: 1283013390 },
  { owner: "elumixor", ownerId: 12294750, repo: "puretype", repoId: 1201954917 },
  { owner: "elumixor", ownerId: 12294750, repo: "telegram-air", repoId: 1362419448 },
  { owner: "elumixor", ownerId: 12294750, repo: "demos", repoId: 1464707458 },
  { owner: "elumixor", ownerId: 12294750, repo: "minigames", repoId: 1461872631 },
  { owner: "elumixor", ownerId: 12294750, repo: "cm-bot", repoId: 1245613884 },
  { owner: "elumixor", ownerId: 12294750, repo: "amcz", repoId: 1247105297 },
  { owner: "elumixor", ownerId: 12294750, repo: "top-margi", repoId: 1366633673 },
  { owner: "elumixor", ownerId: 12294750, repo: "money", repoId: 1415741993 },
  { owner: "elumixor", ownerId: 12294750, repo: "keep", repoId: 1435042034 },
  { owner: "elumixor", ownerId: 12294750, repo: "desk", repoId: 1435430595 },
  { owner: "elumixor", ownerId: 12294750, repo: "people", repoId: 1435510796 },
  { owner: "elumixor", ownerId: 12294750, repo: "prout-slides", repoId: 1287804822 },
  { owner: "elumixor", ownerId: 12294750, repo: "portfolio", repoId: 295776241 },
] as const;

/** Who may assume the deploy role: exactly the `main` branch of each repo in `DEPLOY_REPOS`. */
export function deployTrust(account: string): PolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Federated: `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com` },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub": DEPLOY_REPOS.map(
              (r) => `repo:${r.owner}@${r.ownerId}/${r.repo}@${r.repoId}:ref:refs/heads/main`,
            ),
          },
        },
      },
    ],
  };
}

/**
 * The role GitHub Actions assumes. Admin only (`devkit cloud bootstrap`): a new role gets `deployTrust`
 * (an existing role's trust is left alone), and the deploy policy is attached, which the deploy role itself is denied.
 */
export async function ensureDeployRole() {
  const account = await accountId();
  const policyArn = await ensureManagedPolicy(platform.deployPolicy, deployPolicy(account));
  const role = await ensureRole(
    platform.deployRole,
    deployTrust(account),
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
  const policyArn = await ensureManagedPolicy(platform.deployPolicy, deployPolicy(await accountId()));
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
