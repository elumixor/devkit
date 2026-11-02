import { $ } from "bun";
import type { WebBuildOptions } from "../build-targets/web.ts";
import { CloudError } from "./aws.ts";
import { stage as names, PRODUCTION, STAGE_BRANCHES } from "./names.ts";

/** One scheduled call into the API, in the shape Vercel's `vercel.json` used. */
export interface CronConfig {
  /** Path the function is called on, e.g. `/api/cron/sync`. */
  path: string;
  /** Cron expression in UTC, five fields. */
  schedule: string;
}

export type Routing = "spa" | "pages" | "ssr";

/** One IAM `Allow` statement the function's role gets besides its own logs and blob prefix. */
export interface Permission {
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

/** The `aws` deploy target's options, in the `devkit.deploy.<name>.options` block. */
export interface AwsTargetOptions extends Omit<WebBuildOptions, "host"> {
  /** Project name: resource names, bucket prefixes and the default hostname (default: repo name). */
  project?: string;
  /** How the edge serves paths that aren't the API (default `spa`). */
  routing?: Routing;
  /** Function memory in MB (default 512 — the account caps functions at 512 until AWS raises it). */
  memory?: number;
  /** Function timeout in seconds (default 120; CloudFront waits 60 s for a first byte, a stream may go on longer). */
  timeout?: number;
  /** Scheduled calls into the API. */
  crons?: CronConfig[];
  /** Custom hostnames per stage, besides the default `<project>.dk.atmagaming.com`. */
  domains?: Record<string, string[]>;
  /** Shell command run with the stage's env after the code is published and before it goes live — migrations. */
  predeploy?: string;
  /** Path the health check hits on the new version before it goes live (default `/api/health`). */
  healthPath?: string;
  /** Stage name to git branch (default production=main, development=develop). */
  stages?: Record<string, string>;
  /** Extra IAM statements for the function — an app that reads other AWS resources, like the dashboard. */
  permissions?: Permission[];
}

export const DEFAULTS = { memory: 512, timeout: 120, routing: "spa" as Routing, healthPath: "/api/health" };

/** A project and stage with every default filled in — what the reconciler and the commands work from. */
export class Target {
  readonly project: string;
  readonly stage: string;
  readonly options: Readonly<AwsTargetOptions>;

  constructor(project: string, stage: string, options: Readonly<AwsTargetOptions> = { apiPrefixes: ["api"] }) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(project))
      throw new CloudError(`Project name "${project}" must be lowercase letters, digits and dashes`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(stage))
      throw new CloudError(`Stage name "${stage}" must be lowercase letters, digits and dashes`);
    this.project = project;
    this.stage = stage;
    this.options = options;
  }

  get functionName() {
    return names.fn(this.project, this.stage);
  }
  get roleName() {
    return names.role(this.project, this.stage);
  }
  get logGroup() {
    return names.logGroup(this.project, this.stage);
  }
  get ssmPrefix() {
    return names.ssmPrefix(this.project, this.stage);
  }
  get defaultHost() {
    return names.defaultHost(this.project, this.stage);
  }
  get domains(): readonly string[] {
    return this.options.domains?.[this.stage] ?? [];
  }
  /** Every hostname that routes to this stage; the first custom domain is the one the app calls its own. */
  get hostnames(): readonly string[] {
    return [...this.domains, this.defaultHost];
  }
  get primaryHost() {
    return this.hostnames[0] as string;
  }
  get apiPrefixes(): readonly string[] {
    return (this.options.apiPrefixes ?? ["api"]).map((prefix) => prefix.replace(/^\/+|\/+$/g, ""));
  }
  get routing() {
    return this.options.routing ?? DEFAULTS.routing;
  }
  get memory() {
    return this.options.memory ?? DEFAULTS.memory;
  }
  get timeout() {
    return this.options.timeout ?? DEFAULTS.timeout;
  }
  get crons(): readonly CronConfig[] {
    return this.options.crons ?? [];
  }
  get healthPath() {
    return this.options.healthPath ?? DEFAULTS.healthPath;
  }
  get permissions(): readonly Permission[] {
    return this.options.permissions ?? [];
  }
  get isProduction() {
    return this.stage === PRODUCTION;
  }
}

/** The project name: configured, or the repo's name, or the package name. */
export async function projectName(options: Pick<AwsTargetOptions, "project">, root = process.cwd()) {
  if (options.project) return options.project;
  const remote = await $`git -C ${root} remote get-url origin`.quiet().nothrow().text();
  const fromRemote = remote
    .trim()
    .replace(/\.git$/, "")
    .split("/")
    .pop();
  if (fromRemote) return fromRemote.toLowerCase();
  const pkg = (await Bun.file(`${root}/package.json`).json()) as { name?: string };
  if (!pkg.name) throw new CloudError("Cannot name the project: no git remote and no package name");
  return pkg.name.replace(/^@.*\//, "").toLowerCase();
}

/** The stage a deploy targets: `--stage`, else the one the current branch deploys. */
export async function resolveStage(flag: string | undefined, stages = STAGE_BRANCHES, root = process.cwd()) {
  if (flag) return flag;
  const branch = (await $`git -C ${root} rev-parse --abbrev-ref HEAD`.quiet().nothrow().text()).trim();
  const stage = Object.entries(stages).find(([, b]) => b === branch)?.[0];
  if (!stage) {
    const known = Object.entries(stages)
      .map(([s, b]) => `${b} → ${s}`)
      .join(", ");
    throw new CloudError(`Branch "${branch}" deploys no stage (${known}) — pass --stage <name>`);
  }
  return stage;
}
