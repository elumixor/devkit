import { join } from "node:path";
import { $ } from "bun";
import { CloudError, log } from "../aws.ts";
import { writeStageEnv } from "../env.ts";
import { projectName, Target } from "../project.ts";
import { awsOptions } from "./context.ts";

const USAGE = "usage: devkit cloud infra plan|apply|sync [--yes]";

interface TerraformOutput {
  value: unknown;
  sensitive: boolean;
}

/**
 * `devkit cloud infra`: the project's Terraform module. `plan` shows changes, `apply` makes them and
 * then syncs, `sync` only copies the configured outputs into each stage's env (SSM).
 */
export async function infra(action: string | undefined, flags: { yes?: boolean }, root = process.cwd()) {
  const options = awsOptions(root);
  const config = options.terraform;
  if (!config) throw new CloudError('No "terraform" in the aws target options — add { dir, env } first');
  const dir = join(root, config.dir ?? "infra");
  const terraform = (...args: string[]) => run(["terraform", `-chdir=${dir}`, ...args]);

  if (action !== "plan" && action !== "apply" && action !== "sync") throw new CloudError(USAGE);
  await terraform("init", "-input=false");
  if (action === "plan") return terraform("plan", "-input=false");
  if (action === "apply") await terraform("apply", "-input=false", ...(flags.yes ? ["-auto-approve"] : []));

  const outputs = JSON.parse(await $`terraform -chdir=${dir} output -json`.quiet().text()) as Record<
    string,
    TerraformOutput
  >;
  const project = await projectName(options, root);
  for (const [stage, mapping] of Object.entries(config.env)) {
    const env = Object.fromEntries(
      Object.entries(mapping).map(([key, output]) => {
        const found = outputs[output];
        if (!found) throw new CloudError(`Terraform has no output "${output}" (wanted for ${stage} ${key})`);
        return [key, typeof found.value === "string" ? found.value : JSON.stringify(found.value)];
      }),
    );
    await writeStageEnv(new Target(project, stage, options), env);
    log(`${project} ${stage}: ${Object.keys(env).join(", ")} ← Terraform (next deploy picks them up)`);
  }
}

/** Terraform asks for approval on stdin, so it gets the terminal. */
async function run(command: string[]) {
  const child = Bun.spawn(command, { stdio: ["inherit", "inherit", "inherit"] });
  const code = await child.exited;
  if (code !== 0) throw new CloudError(`${command.slice(0, 2).join(" ")} ${command[2]} exited with ${code}`);
}
