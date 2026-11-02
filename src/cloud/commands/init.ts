import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { accountId, log } from "../aws.ts";
import { platform, REGION, STAGE_BRANCHES } from "../names.ts";

const WORKFLOW_PATH = ".github/workflows/deploy.yml";

/** Once per repo: the `aws` deploy target in package.json and the workflow that runs it. */
export async function init(root = process.cwd()) {
  const account = await accountId();
  const workflow = resolve(root, WORKFLOW_PATH);
  await mkdir(resolve(root, ".github/workflows"), { recursive: true });
  await Bun.write(workflow, deployWorkflow(account));
  log(`Wrote ${WORKFLOW_PATH}`);

  const pkgPath = resolve(root, "package.json");
  if (!existsSync(pkgPath)) return log("No package.json here — add the aws deploy target by hand");
  const text = await Bun.file(pkgPath).text();
  const pkg = JSON.parse(text) as {
    devkit?: { deploy?: Record<string, { type?: string; options?: Record<string, unknown> }> };
  };
  const deploy = pkg.devkit?.deploy ?? {};
  const vercel = Object.entries(deploy).find(([, step]) => step.type === "vercel");
  const aws = Object.entries(deploy).find(([, step]) => step.type === "aws");
  if (aws) return log(`package.json already deploys "${aws[0]}" to aws`);

  const name = vercel?.[0] ?? "web";
  const buildOptions =
    (pkg as { devkit?: { build?: Record<string, { options?: Record<string, unknown> }> } }).devkit?.build?.[name]
      ?.options ?? {};
  const options = { ...buildOptions, ...(vercel?.[1].options ?? {}), apiPrefixes: buildOptions.apiPrefixes ?? ["api"] };
  const next = {
    ...pkg,
    devkit: { ...pkg.devkit, deploy: { ...deploy, [name]: { ...(deploy[name] ?? {}), type: "aws", options } } },
  };
  await Bun.write(pkgPath, `${JSON.stringify(next, null, 2)}\n`);
  log(`package.json: devkit.deploy.${name} now deploys to aws${vercel ? " (was vercel)" : ""}`);
}

function deployWorkflow(account: string) {
  const branches = Object.values(STAGE_BRANCHES);
  return `name: deploy

on:
  push:
    branches: [${branches.join(", ")}]

# One deploy per stage at a time; a second push waits rather than racing the first.
concurrency:
  group: deploy-\${{ github.ref_name }}
  cancel-in-progress: false

permissions:
  id-token: write
  contents: read
  deployments: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::${account}:role/${platform.deployRole}
          aws-region: ${REGION}
      - run: bun install --frozen-lockfile
      - run: bunx devkit deploy
        env:
          GITHUB_TOKEN: \${{ github.token }}
`;
}
