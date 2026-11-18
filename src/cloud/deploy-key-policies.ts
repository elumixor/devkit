/**
 * The IAM and EventBridge documents behind `devkit cloud deploy-key`: a machine that cannot use GitHub's
 * OIDC (the box) deploys with a long-lived key that can do exactly one thing, assume an IP-locked role
 * for 15 minutes. Pure functions, so the documents are tested without AWS.
 */

/** Names may only make `dk-deploy-<name>`; `local` is the laptop profile's user and is never handed out. */
const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;

export function deployKeyName(name: string | undefined) {
  if (!name || !NAME.test(name) || name === "local")
    throw new Error(`deploy key name must match ${NAME} and not be "local" (got "${name ?? ""}")`);
  return `dk-deploy-${name}`;
}

/** The one address the key may be used from, checked; policies get it as a one-host CIDR. */
export function sourceIp(ip: string | undefined) {
  if (!ip) throw new Error("--source-ip is required: the one address the key may be used from");
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && ip.split(".").every((part) => Number(part) <= 255);
  const v6 = !v4 && /^[0-9a-f:]+$/i.test(ip) && ip.includes(":");
  if (!v4 && !v6) throw new Error(`--source-ip "${ip}" is not a single IP address`);
  return { ip, cidr: `${ip}/${v4 ? 32 : 128}` };
}

/**
 * The cap AssumeRole's DurationSeconds is held to, through the `sts:DurationSeconds` condition: a role's
 * MaxSessionDuration cannot go below 3600, so the trust and the user's policy enforce the 15 minutes.
 */
export const DEPLOY_KEY_SESSION_SECONDS = 900;

type Document = { Version: "2012-10-17"; Statement: Record<string, unknown>[] };

/** The user's only permission: assume its own role, from the one address. */
export function deployKeyUserPolicy(account: string, name: string, cidr: string): Document {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Resource: `arn:aws:iam::${account}:role/${name}`,
        Condition: {
          IpAddress: { "aws:SourceIp": cidr },
          NumericLessThanEquals: { "sts:DurationSeconds": DEPLOY_KEY_SESSION_SECONDS },
        },
      },
    ],
  };
}

/** The role trusts that one user, from the one address. */
export function deployKeyTrust(account: string, name: string, cidr: string): Document {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${account}:user/${name}` },
        Action: "sts:AssumeRole",
        Condition: {
          IpAddress: { "aws:SourceIp": cidr },
          NumericLessThanEquals: { "sts:DurationSeconds": DEPLOY_KEY_SESSION_SECONDS },
        },
      },
    ],
  };
}

/**
 * Inline on the role, next to the `dk-deploy` managed policy: session credentials copied off the box are
 * useless anywhere else, and the session can never touch the deploy identities themselves (the managed
 * policy's `iam:*Role*` on `role/dk-*` would otherwise reach this very role). Calls AWS makes on the
 * session's behalf (Lambda fetching code from S3) carry no source IP, so they are exempt.
 */
export function deployKeyGuard(account: string, cidr: string): Document {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Deny",
        Action: "*",
        Resource: "*",
        Condition: { NotIpAddress: { "aws:SourceIp": cidr }, Bool: { "aws:ViaAWSService": "false" } },
      },
      {
        Effect: "Deny",
        Action: "iam:*",
        Resource: [
          `arn:aws:iam::${account}:role/dk-deploy*`,
          `arn:aws:iam::${account}:user/dk-deploy*`,
          `arn:aws:iam::${account}:policy/dk-deploy*`,
        ],
      },
    ],
  };
}

/**
 * Any API call by the user or a session of its role from an address other than the allowed one. A call an
 * AWS service makes for the session reports the service as its source and alerts too; those are rare here.
 */
export function deployKeyAlertPattern(account: string, name: string, ip: string) {
  return {
    "detail-type": ["AWS API Call via CloudTrail"],
    detail: {
      userIdentity: {
        arn: [`arn:aws:iam::${account}:user/${name}`, { prefix: `arn:aws:sts::${account}:assumed-role/${name}/` }],
      },
      sourceIPAddress: [{ "anything-but": [ip] }],
    },
  };
}

/** What `deploy-key` prints: the base key and the role, as env lines a secrets holder stores. */
export function deployKeyEnv(account: string, name: string, accessKeyId: string, secret: string, region: string) {
  return [
    `DK_DEPLOY_ACCESS_KEY_ID=${accessKeyId}`,
    `DK_DEPLOY_SECRET_ACCESS_KEY=${secret}`,
    `DK_DEPLOY_ROLE_ARN=arn:aws:iam::${account}:role/${name}`,
    `AWS_REGION=${region}`,
  ].join("\n");
}

/** What `devkit cloud session` prints: temporary credentials only, ready for `export`. */
export function sessionEnv(credentials: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string }) {
  return [
    `AWS_ACCESS_KEY_ID=${credentials.AccessKeyId}`,
    `AWS_SECRET_ACCESS_KEY=${credentials.SecretAccessKey}`,
    `AWS_SESSION_TOKEN=${credentials.SessionToken}`,
  ].join("\n");
}

/** Credential variables a stage's env must never put over the deploy's own. */
const DEPLOY_CREDENTIALS = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
]);

/** The stage's env minus anything that would swap the credentials the deploy itself runs with. */
export function withoutDeployCredentials(env: Readonly<Record<string, string>>) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !DEPLOY_CREDENTIALS.has(key)));
}
