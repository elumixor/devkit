import { hostname } from "node:os";
import {
  DeleteRuleCommand,
  EventBridgeClient,
  PutRuleCommand,
  PutTargetsCommand,
  RemoveTargetsCommand,
} from "@aws-sdk/client-eventbridge";
import {
  AttachRolePolicyCommand,
  CreateAccessKeyCommand,
  CreateRoleCommand,
  CreateUserCommand,
  DeleteAccessKeyCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  DeleteUserCommand,
  DeleteUserPolicyCommand,
  DetachRolePolicyCommand,
  GetRoleCommand,
  GetUserCommand,
  ListAccessKeysCommand,
  PutRolePolicyCommand,
  PutUserPolicyCommand,
  UpdateAssumeRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
  CreateTopicCommand,
  ListSubscriptionsByTopicCommand,
  SetTopicAttributesCommand,
  SNSClient,
  SubscribeCommand,
} from "@aws-sdk/client-sns";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { $ } from "bun";
import { accountId, CloudError, iam, orUndefined, platformTags, retryWhile } from "../aws.ts";
import {
  DEPLOY_KEY_SESSION_SECONDS,
  deployKeyAlertPattern,
  deployKeyEnv,
  deployKeyGuard,
  deployKeyName,
  deployKeyTrust,
  deployKeyUserPolicy,
  sessionEnv,
  sourceIp,
} from "../deploy-key-policies.ts";
import { GLOBAL_REGION, platform, REGION } from "../names.ts";
import { deployPolicy, ensureManagedPolicy } from "../reconcile/iam.ts";

export interface DeployKeyOptions {
  sourceIp?: string;
  rotate?: boolean;
  revoke?: boolean;
  email?: string;
}

/** Progress goes to stderr: stdout carries only the credentials, so it can be piped to another machine. */
const say = (message: string) => console.error(message);

/** IAM is global, but its events (and CloudFront's) arrive in us-east-1; everything else in the home region. */
const ALERT_REGIONS = [REGION, GLOBAL_REGION] as const;
const ALERT_TOPIC = "dk-deploy-alerts";

/**
 * `devkit cloud deploy-key <name> --source-ip <ip>`: a user `dk-deploy-<name>` whose key may only assume
 * the role `dk-deploy-<name>` (the `dk-deploy` policy) for 15 minutes from that address, plus an alert on
 * any use from elsewhere. Prints the key once; nothing is written to disk. Run with admin credentials.
 */
export async function deployKey(name: string | undefined, options: DeployKeyOptions) {
  const user = deployKeyName(name);
  if (options.revoke) return revoke(user);
  const { ip, cidr } = sourceIp(options.sourceIp);
  const account = await accountId();

  const existing = await orUndefined(iam().send(new GetUserCommand({ UserName: user })), "NoSuchEntityException");
  if (!existing)
    await iam().send(new CreateUserCommand({ UserName: user, Tags: platformTags({ "dk-source-ip": ip }) }));
  await iam().send(
    new PutUserPolicyCommand({
      UserName: user,
      PolicyName: user,
      PolicyDocument: JSON.stringify(deployKeyUserPolicy(account, user, cidr)),
    }),
  );
  say(`user ${user} ${existing ? "ok" : "created"} (only sts:AssumeRole on role/${user} from ${ip})`);

  await ensureKeyRole(account, user, cidr);
  say(`role ${user} ok (policy ${platform.deployPolicy}, ${DEPLOY_KEY_SESSION_SECONDS}s sessions from ${ip})`);

  await ensureAlerts(account, user, ip, options.email);

  const keys = (await iam().send(new ListAccessKeysCommand({ UserName: user }))).AccessKeyMetadata ?? [];
  if (keys.length && !options.rotate) {
    say(`policies updated; ${user} keeps its key ${keys[0]?.AccessKeyId} (pass --rotate for a new one)`);
    return;
  }
  if (keys.length >= 2)
    throw new CloudError(`${user} has two keys already; run --rotate once the older one is no longer needed`);

  const key = await iam().send(new CreateAccessKeyCommand({ UserName: user }));
  if (!key.AccessKey?.AccessKeyId || !key.AccessKey.SecretAccessKey) throw new CloudError("IAM returned no access key");
  for (const old of keys) {
    if (!old.AccessKeyId) continue;
    await iam().send(new DeleteAccessKeyCommand({ UserName: user, AccessKeyId: old.AccessKeyId }));
    say(`deleted old key ${old.AccessKeyId}`);
  }
  say(`key ${key.AccessKey.AccessKeyId} created; rotate within 90 days with --rotate`);
  console.log(deployKeyEnv(account, user, key.AccessKey.AccessKeyId, key.AccessKey.SecretAccessKey, REGION));
}

async function ensureKeyRole(account: string, name: string, cidr: string) {
  const trust = JSON.stringify(deployKeyTrust(account, name, cidr));
  const existing = await orUndefined(iam().send(new GetRoleCommand({ RoleName: name })), "NoSuchEntityException");
  // A user just created is not always accepted as a principal yet.
  if (existing) await iam().send(new UpdateAssumeRolePolicyCommand({ RoleName: name, PolicyDocument: trust }));
  else
    await retryWhile(
      () =>
        iam().send(
          new CreateRoleCommand({
            RoleName: name,
            AssumeRolePolicyDocument: trust,
            MaxSessionDuration: 3600,
            Description: "Devkit Cloud: deploys from one machine through its deploy key",
            Tags: platformTags(),
          }),
        ),
      ["MalformedPolicyDocumentException"],
    );
  const policyArn = await ensureManagedPolicy(platform.deployPolicy, await deployPolicy());
  await retryWhile(
    () => iam().send(new AttachRolePolicyCommand({ RoleName: name, PolicyArn: policyArn })),
    ["NoSuchEntityException"],
  );
  await iam().send(
    new PutRolePolicyCommand({
      RoleName: name,
      PolicyName: `${name}-guard`,
      PolicyDocument: JSON.stringify(deployKeyGuard(account, cidr)),
    }),
  );
}

/** One SNS topic per region (EventBridge targets stay in-region) and a rule per key in each. */
async function ensureAlerts(account: string, name: string, ip: string, email: string | undefined) {
  const to = email ?? (await $`git config user.email`.quiet().nothrow().text()).trim();
  if (!to) throw new CloudError("No email for alerts: pass --email or set git config user.email");
  for (const region of ALERT_REGIONS) {
    const sns = new SNSClient({ region });
    const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: ALERT_TOPIC, Tags: platformTags() }));
    if (!TopicArn) throw new CloudError(`SNS returned no topic ARN in ${region}`);
    await sns.send(
      new SetTopicAttributesCommand({
        TopicArn,
        AttributeName: "Policy",
        AttributeValue: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "events.amazonaws.com" },
              Action: "sns:Publish",
              Resource: TopicArn,
              Condition: { StringEquals: { "aws:SourceAccount": account } },
            },
          ],
        }),
      }),
    );
    const subscriptions = (await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn }))).Subscriptions ?? [];
    if (!subscriptions.some((subscription) => subscription.Endpoint === to)) {
      await sns.send(new SubscribeCommand({ TopicArn, Protocol: "email", Endpoint: to }));
      say(`  alerts ${region}: confirm the subscription email sent to ${to}`);
    }
    const events = new EventBridgeClient({ region });
    await events.send(
      new PutRuleCommand({
        Name: `${name}-ip`,
        Description: `Devkit Cloud: ${name} used from an address other than ${ip}`,
        EventPattern: JSON.stringify(deployKeyAlertPattern(account, name, ip)),
        State: "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS",
        Tags: platformTags(),
      }),
    );
    await events.send(new PutTargetsCommand({ Rule: `${name}-ip`, Targets: [{ Id: "sns", Arn: TopicArn }] }));
  }
  say(`alert rule ${name}-ip ok in ${ALERT_REGIONS.join(", ")} (SNS ${ALERT_TOPIC} to ${to})`);
}

/** Deletes the keys, the user, the role and its alert rules; the shared alert topic stays. */
async function revoke(name: string) {
  const account = await accountId();
  const keys = (await orUndefined(iam().send(new ListAccessKeysCommand({ UserName: name })), "NoSuchEntityException"))
    ?.AccessKeyMetadata;
  for (const key of keys ?? [])
    if (key.AccessKeyId) await iam().send(new DeleteAccessKeyCommand({ UserName: name, AccessKeyId: key.AccessKeyId }));
  const gone = ["NoSuchEntityException"];
  await orUndefined(iam().send(new DeleteUserPolicyCommand({ UserName: name, PolicyName: name })), ...gone);
  await orUndefined(iam().send(new DeleteUserCommand({ UserName: name })), ...gone);
  await orUndefined(
    iam().send(
      new DetachRolePolicyCommand({
        RoleName: name,
        PolicyArn: `arn:aws:iam::${account}:policy/${platform.deployPolicy}`,
      }),
    ),
    ...gone,
  );
  await orUndefined(iam().send(new DeleteRolePolicyCommand({ RoleName: name, PolicyName: `${name}-guard` })), ...gone);
  await orUndefined(iam().send(new DeleteRoleCommand({ RoleName: name })), ...gone);
  for (const region of ALERT_REGIONS) {
    const events = new EventBridgeClient({ region });
    await orUndefined(
      events.send(new RemoveTargetsCommand({ Rule: `${name}-ip`, Ids: ["sns"] })),
      "ResourceNotFoundException",
    );
    await orUndefined(events.send(new DeleteRuleCommand({ Name: `${name}-ip` })), "ResourceNotFoundException");
  }
  say(`revoked ${name}: keys, user, role and alert rules deleted`);
}

/**
 * `devkit cloud session`: on the machine holding the deploy key, trades it for 15-minute credentials and
 * prints only those, so a deploy never sees the long-lived key.
 */
export async function session() {
  const { DK_DEPLOY_ACCESS_KEY_ID: accessKeyId, DK_DEPLOY_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
  const roleArn = process.env.DK_DEPLOY_ROLE_ARN;
  if (!accessKeyId || !secretAccessKey || !roleArn)
    throw new CloudError(
      "Set DK_DEPLOY_ACCESS_KEY_ID, DK_DEPLOY_SECRET_ACCESS_KEY and DK_DEPLOY_ROLE_ARN (from deploy-key)",
    );
  const sts = new STSClient({
    region: process.env.AWS_REGION ?? REGION,
    credentials: { accessKeyId, secretAccessKey },
  });
  const { Credentials } = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `devkit-${hostname()}`.replace(/[^\w+=,.@-]/g, "-").slice(0, 64),
      DurationSeconds: DEPLOY_KEY_SESSION_SECONDS,
    }),
  );
  if (!Credentials?.AccessKeyId || !Credentials.SecretAccessKey || !Credentials.SessionToken)
    throw new CloudError("STS returned no credentials");
  console.log(
    sessionEnv({
      AccessKeyId: Credentials.AccessKeyId,
      SecretAccessKey: Credentials.SecretAccessKey,
      SessionToken: Credentials.SessionToken,
    }),
  );
}
