import { describe, expect, test } from "bun:test";
import {
  DEPLOY_KEY_SESSION_SECONDS,
  deployKeyAlertPattern,
  deployKeyEnv,
  deployKeyGuard,
  deployKeyName,
  deployKeyTrust,
  deployKeyUserPolicy,
  sourceIp,
  withoutDeployCredentials,
} from "./deploy-key-policies.ts";

const account = "123456789012";
const name = "dk-deploy-box";
const cidr = "203.0.113.7/32";

describe("deploy key names and addresses", () => {
  test("names map to dk-deploy-<name>, never the laptop user", () => {
    expect(deployKeyName("box")).toBe("dk-deploy-box");
    expect(() => deployKeyName("local")).toThrow();
    expect(() => deployKeyName("Box")).toThrow();
    expect(() => deployKeyName("a/b")).toThrow();
    expect(() => deployKeyName(undefined)).toThrow();
  });

  test("source ip is required and one host", () => {
    expect(sourceIp("203.0.113.7")).toEqual({ ip: "203.0.113.7", cidr });
    expect(sourceIp("2001:db8::1").cidr).toBe("2001:db8::1/128");
    expect(() => sourceIp(undefined)).toThrow("--source-ip is required");
    expect(() => sourceIp("0.0.0.0/0")).toThrow();
    expect(() => sourceIp("300.0.0.1")).toThrow();
  });
});

describe("deploy key policies", () => {
  test("user may only assume its own role, from the ip, for at most 15 minutes", () => {
    const { Statement } = deployKeyUserPolicy(account, name, cidr);
    expect(Statement).toEqual([
      {
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Resource: `arn:aws:iam::${account}:role/${name}`,
        Condition: {
          IpAddress: { "aws:SourceIp": cidr },
          NumericLessThanEquals: { "sts:DurationSeconds": 900 },
        },
      },
    ]);
    expect(Statement.map((statement) => statement.Action)).toEqual(["sts:AssumeRole"]);
    expect(DEPLOY_KEY_SESSION_SECONDS).toBe(900);
  });

  test("role trusts only that user, from the ip, for at most 15 minutes", () => {
    const [statement, ...rest] = deployKeyTrust(account, name, cidr).Statement;
    expect(rest).toHaveLength(0);
    expect(statement).toEqual({
      Effect: "Allow",
      Principal: { AWS: `arn:aws:iam::${account}:user/${name}` },
      Action: "sts:AssumeRole",
      Condition: {
        IpAddress: { "aws:SourceIp": cidr },
        NumericLessThanEquals: { "sts:DurationSeconds": 900 },
      },
    });
  });

  test("guard denies use off the ip (except AWS acting for the session) and any IAM on deploy identities", () => {
    const [offIp, iam] = deployKeyGuard(account, cidr).Statement;
    expect(offIp).toEqual({
      Effect: "Deny",
      Action: "*",
      Resource: "*",
      Condition: { NotIpAddress: { "aws:SourceIp": cidr }, Bool: { "aws:ViaAWSService": "false" } },
    });
    expect(iam).toMatchObject({ Effect: "Deny", Action: "iam:*" });
    expect(iam?.Resource).toContain(`arn:aws:iam::${account}:role/dk-deploy*`);
    expect(iam?.Resource).toContain(`arn:aws:iam::${account}:user/dk-deploy*`);
  });

  test("alert matches the user and its role sessions from any other address", () => {
    expect(deployKeyAlertPattern(account, name, "203.0.113.7")).toEqual({
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        userIdentity: {
          arn: [`arn:aws:iam::${account}:user/${name}`, { prefix: `arn:aws:sts::${account}:assumed-role/${name}/` }],
        },
        sourceIPAddress: [{ "anything-but": ["203.0.113.7"] }],
      },
    });
  });

  test("printed key never uses AWS_* credential names, so it cannot deploy directly", () => {
    const env = deployKeyEnv(account, name, "AKIA1", "secret", "eu-central-1");
    expect(env).toContain("DK_DEPLOY_ACCESS_KEY_ID=AKIA1");
    expect(env).toContain(`DK_DEPLOY_ROLE_ARN=arn:aws:iam::${account}:role/${name}`);
    expect(env).not.toMatch(/^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)=/m);
  });
});

describe("deploy credentials", () => {
  test("a stage env's AWS keys never replace the deploy's own credentials", () => {
    expect(
      withoutDeployCredentials({
        AWS_ACCESS_KEY_ID: "app",
        AWS_SECRET_ACCESS_KEY: "app",
        AWS_SESSION_TOKEN: "app",
        AWS_PROFILE: "app",
        VITE_API: "x",
        AWS_S3_BUCKET: "kept",
      }),
    ).toEqual({ VITE_API: "x", AWS_S3_BUCKET: "kept" });
  });
});
