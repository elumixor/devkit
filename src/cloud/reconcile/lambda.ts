import {
  AddPermissionCommand,
  CreateAliasCommand,
  CreateFunctionCommand,
  CreateFunctionUrlConfigCommand,
  DeleteFunctionCommand,
  GetAliasCommand,
  GetFunctionConfigurationCommand,
  GetFunctionUrlConfigCommand,
  InvokeWithResponseStreamCommand,
  ListVersionsByFunctionCommand,
  PublishVersionCommand,
  PutFunctionConcurrencyCommand,
  UpdateAliasCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  UpdateFunctionUrlConfigCommand,
} from "@aws-sdk/client-lambda";
import { CloudError, lambda, orUndefined, retryWhile, waitFor } from "../aws.ts";
import { LIVE_ALIAS } from "../names.ts";
import type { Target } from "../project.ts";

export const RUNTIME = "nodejs24.x";
export const ARCHITECTURE = "arm64";
/** The entry the deploy writes next to Nitro's output; see `src/cloud/runtime-wrapper.ts`. */
export const HANDLER = "dk-handler.handler";
/** Caps what a runaway loop can cost, and how many database connections one stage can open. */
export const RESERVED_CONCURRENCY = 20;
/** Lambda rejects a configuration whose variables total more than this. */
export const ENV_LIMIT_BYTES = 4096;

export interface FunctionCode {
  bucket: string;
  key: string;
}

export interface FunctionSpec {
  roleArn: string;
  code: FunctionCode;
  env: Readonly<Record<string, string>>;
  description: string;
}

export function envSize(env: Readonly<Record<string, string>>) {
  return Object.entries(env).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value), 0);
}

/** Creates or updates the function's code and config, then publishes an immutable version of it. */
export async function publishFunction(
  target: Target,
  spec: FunctionSpec,
): Promise<{ version: string; created: boolean }> {
  const size = envSize(spec.env);
  if (size > ENV_LIMIT_BYTES) {
    const biggest = Object.entries(spec.env)
      .sort(([, a], [, b]) => b.length - a.length)
      .slice(0, 5)
      .map(([key, value]) => `${key} (${value.length} chars)`)
      .join(", ");
    throw new CloudError(
      `Stage env is ${size} bytes; Lambda allows ${ENV_LIMIT_BYTES}. Biggest: ${biggest}. Move large values out of env.`,
    );
  }

  const name = target.functionName;
  const existing = await orUndefined(
    lambda().send(new GetFunctionConfigurationCommand({ FunctionName: name })),
    "ResourceNotFoundException",
  );

  if (!existing) {
    // A role made moments ago is not yet visible to Lambda; the create is retried until it is.
    await retryWhile(
      () =>
        lambda().send(
          new CreateFunctionCommand({
            FunctionName: name,
            Runtime: RUNTIME,
            Architectures: [ARCHITECTURE],
            Handler: HANDLER,
            Role: spec.roleArn,
            Code: { S3Bucket: spec.code.bucket, S3Key: spec.code.key },
            MemorySize: target.memory,
            Timeout: target.timeout,
            Environment: { Variables: { ...spec.env } },
            Description: spec.description,
            Tags: { dk: "platform", project: target.project, stage: target.stage },
          }),
        ),
      ["InvalidParameterValueException"],
    );
    await waitSettled(name);
  } else {
    await lambda().send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: name,
        Runtime: RUNTIME,
        Handler: HANDLER,
        Role: spec.roleArn,
        MemorySize: target.memory,
        Timeout: target.timeout,
        Environment: { Variables: { ...spec.env } },
        Description: spec.description,
      }),
    );
    await waitSettled(name);
    await lambda().send(
      new UpdateFunctionCodeCommand({
        FunctionName: name,
        S3Bucket: spec.code.bucket,
        S3Key: spec.code.key,
        Architectures: [ARCHITECTURE],
      }),
    );
    await waitSettled(name);
  }

  await lambda().send(
    new PutFunctionConcurrencyCommand({ FunctionName: name, ReservedConcurrentExecutions: RESERVED_CONCURRENCY }),
  );

  const published = await lambda().send(
    new PublishVersionCommand({ FunctionName: name, Description: spec.description }),
  );
  if (!published.Version) throw new CloudError(`Lambda published no version for ${name}`);
  return { version: published.Version, created: !existing };
}

/** Lambda applies updates asynchronously; the next call fails until the last one has settled. */
async function waitSettled(name: string) {
  await waitFor(
    `${name} to finish updating`,
    async () => {
      const config = await lambda().send(new GetFunctionConfigurationCommand({ FunctionName: name }));
      if (config.State === "Failed" || config.LastUpdateStatus === "Failed")
        throw new CloudError(
          `${name} update failed: ${config.LastUpdateStatusReason ?? config.StateReason ?? "no reason given"}`,
        );
      return config.State === "Active" && config.LastUpdateStatus === "Successful" ? true : undefined;
    },
    { everyMs: 1500, timeoutMs: 5 * 60 * 1000 },
  );
}

/** Points `live` at a version — the moment a deploy or a rollback takes effect for the API. */
export async function pointLiveAlias(functionName: string, version: string) {
  const alias = await orUndefined(
    lambda().send(new GetAliasCommand({ FunctionName: functionName, Name: LIVE_ALIAS })),
    "ResourceNotFoundException",
  );
  if (!alias) {
    const created = await lambda().send(
      new CreateAliasCommand({ FunctionName: functionName, Name: LIVE_ALIAS, FunctionVersion: version }),
    );
    return { arn: created.AliasArn as string, created: true };
  }
  if (alias.FunctionVersion !== version)
    await lambda().send(
      new UpdateAliasCommand({ FunctionName: functionName, Name: LIVE_ALIAS, FunctionVersion: version }),
    );
  return { arn: alias.AliasArn as string, created: false };
}

export async function liveVersion(functionName: string) {
  const alias = await orUndefined(
    lambda().send(new GetAliasCommand({ FunctionName: functionName, Name: LIVE_ALIAS })),
    "ResourceNotFoundException",
  );
  return alias?.FunctionVersion;
}

/**
 * The Function URL on the `live` alias: open to the internet (auth NONE) because CloudFront can't
 * sign browser POST bodies, and closed by the edge secret the runtime wrapper checks instead.
 */
export async function ensureFunctionUrl(functionName: string): Promise<string> {
  const existing = await orUndefined(
    lambda().send(new GetFunctionUrlConfigCommand({ FunctionName: functionName, Qualifier: LIVE_ALIAS })),
    "ResourceNotFoundException",
  );
  let url = existing?.FunctionUrl;
  if (!existing) {
    const created = await lambda().send(
      new CreateFunctionUrlConfigCommand({
        FunctionName: functionName,
        Qualifier: LIVE_ALIAS,
        AuthType: "NONE",
        InvokeMode: "RESPONSE_STREAM",
      }),
    );
    url = created.FunctionUrl;
  } else if (existing.InvokeMode !== "RESPONSE_STREAM" || existing.AuthType !== "NONE") {
    await lambda().send(
      new UpdateFunctionUrlConfigCommand({
        FunctionName: functionName,
        Qualifier: LIVE_ALIAS,
        AuthType: "NONE",
        InvokeMode: "RESPONSE_STREAM",
      }),
    );
  }
  if (!url) throw new CloudError(`Lambda returned no URL for ${functionName}`);

  // Both grants are needed: the URL permission, and a plain invoke permission limited to calls
  // that arrive through the URL — without the second, every request is a 403.
  await orUndefined(
    lambda().send(
      new AddPermissionCommand({
        FunctionName: functionName,
        Qualifier: LIVE_ALIAS,
        StatementId: "dk-url",
        Action: "lambda:InvokeFunctionUrl",
        Principal: "*",
        FunctionUrlAuthType: "NONE",
      }),
    ),
    "ResourceConflictException",
  );
  await orUndefined(
    lambda().send(
      new AddPermissionCommand({
        FunctionName: functionName,
        Qualifier: LIVE_ALIAS,
        StatementId: "dk-url-invoke",
        Action: "lambda:InvokeFunction",
        Principal: "*",
        InvokedViaFunctionUrl: true,
      }),
    ),
    "ResourceConflictException",
  );
  return url;
}

/** The hostname part of a Function URL — what the router points the origin at. */
export const urlHost = (url: string) => new URL(url).host;

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Invokes one version with a Function-URL-shaped event, as the health check does before a deploy
 * goes live. The streamed payload begins with the JSON prelude the wrapper writes, then 8 NULs.
 */
export async function invokeHttp(functionName: string, qualifier: string, event: unknown): Promise<HttpResult> {
  const result = await lambda().send(
    new InvokeWithResponseStreamCommand({
      FunctionName: functionName,
      Qualifier: qualifier,
      Payload: JSON.stringify(event),
    }),
  );
  const chunks: Uint8Array[] = [];
  let failure: string | undefined;
  for await (const item of result.EventStream ?? []) {
    if (item.PayloadChunk?.Payload) chunks.push(item.PayloadChunk.Payload);
    if (item.InvokeComplete?.ErrorCode)
      failure = `${item.InvokeComplete.ErrorCode}: ${item.InvokeComplete.ErrorDetails ?? ""}`;
  }
  if (failure) throw new CloudError(`Invocation failed — ${failure}`);
  const raw = Buffer.concat(chunks);
  const separator = Buffer.alloc(8);
  const at = raw.indexOf(separator);
  if (at < 0) return { status: 200, headers: {}, body: raw.toString("utf8") };
  const prelude = JSON.parse(raw.subarray(0, at).toString("utf8")) as {
    statusCode?: number;
    headers?: Record<string, string>;
  };
  return {
    status: prelude.statusCode ?? 200,
    headers: prelude.headers ?? {},
    body: raw.subarray(at + separator.length).toString("utf8"),
  };
}

/** Numbered versions newest first, for pruning. */
export async function listVersions(functionName: string) {
  const versions: string[] = [];
  let Marker: string | undefined;
  do {
    const page = await lambda().send(new ListVersionsByFunctionCommand({ FunctionName: functionName, Marker }));
    for (const version of page.Versions ?? [])
      if (version.Version && version.Version !== "$LATEST") versions.push(version.Version);
    Marker = page.NextMarker;
  } while (Marker);
  return versions.sort((a, b) => Number(b) - Number(a));
}

export async function deleteVersion(functionName: string, version: string) {
  await orUndefined(
    lambda().send(new DeleteFunctionCommand({ FunctionName: functionName, Qualifier: version })),
    "ResourceNotFoundException",
    "ResourceConflictException",
  );
}

export async function deleteFunction(functionName: string) {
  await orUndefined(
    lambda().send(new DeleteFunctionCommand({ FunctionName: functionName })),
    "ResourceNotFoundException",
  );
}
