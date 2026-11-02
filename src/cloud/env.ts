import { randomBytes } from "node:crypto";
import {
  DeleteParameterCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";
import { orUndefined, ssm } from "./aws.ts";
import type { Target } from "./project.ts";

export type Env = Record<string, string>;

/** Every variable under a path, decrypted — a stage's env, or the platform's own settings. */
export async function readEnvAt(prefix: string): Promise<Env> {
  const env: Env = {};
  let NextToken: string | undefined;
  do {
    const page = await ssm().send(
      new GetParametersByPathCommand({ Path: prefix, Recursive: false, WithDecryption: true, NextToken }),
    );
    for (const parameter of page.Parameters ?? []) {
      if (parameter.Name && parameter.Value !== undefined) env[parameter.Name.slice(prefix.length)] = parameter.Value;
    }
    NextToken = page.NextToken;
  } while (NextToken);
  return env;
}

export const readStageEnv = (target: Target) => readEnvAt(target.ssmPrefix);

export async function readParameter(name: string) {
  const result = await orUndefined(
    ssm().send(new GetParameterCommand({ Name: name, WithDecryption: true })),
    "ParameterNotFound",
  );
  return result?.Parameter?.Value;
}

/** Every value is a SecureString under the free `aws/ssm` key: nothing to classify, nothing to leak in a listing. */
export async function writeParameter(name: string, value: string) {
  await ssm().send(
    new PutParameterCommand({ Name: name, Value: value, Type: "SecureString", Overwrite: true, Tier: "Standard" }),
  );
}

export async function writeStageEnv(target: Target, env: Readonly<Env>) {
  for (const [key, value] of Object.entries(env)) await writeParameter(target.ssmPrefix + key, value);
}

export async function deleteStageVariable(target: Target, key: string) {
  await orUndefined(ssm().send(new DeleteParameterCommand({ Name: target.ssmPrefix + key })), "ParameterNotFound");
}

export async function deleteStageEnv(target: Target) {
  for (const key of Object.keys(await readStageEnv(target))) await deleteStageVariable(target, key);
}

/** Reads a parameter, or makes and stores one — for secrets nobody needs to choose. */
export async function ensureSecret(name: string, bytes = 32) {
  const existing = await readParameter(name);
  if (existing) return existing;
  const secret = randomBytes(bytes).toString("base64url");
  await writeParameter(name, secret);
  return secret;
}

/** `KEY=value` lines; quotes stripped, `#` comments and blanks skipped, `export ` tolerated. */
export function parseDotenv(text: string): Env {
  const env: Env = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match as unknown as [string, string, string];
    env[key] = unquote(rest);
  }
  return env;
}

function unquote(value: string) {
  const trimmed = value.trim();
  if (/^".*"$/.test(trimmed)) return trimmed.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
  if (/^'.*'$/.test(trimmed)) return trimmed.slice(1, -1);
  return trimmed.replace(/\s+#.*$/, "");
}

export function formatDotenv(env: Readonly<Env>) {
  return `${Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${/[\s#"']/.test(value) || value === "" ? JSON.stringify(value) : value}`)
    .join("\n")}\n`;
}
