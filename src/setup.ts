import { $ } from "bun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, type EnvFile, type SetupConfig } from "./config.ts";

/**
 * Parse `KEY=value` lines. Deliberately tolerant: blank lines, comments, quoted
 * values and `export` prefixes all show up in real .env files.
 */
function parseEnv(text: string) {
  const vars = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match?.[1]) continue;
    vars.set(match[1], (match[2] ?? "").replace(/^(["'])(.*)\1$/, "$2"));
  }
  return vars;
}

/**
 * Validate one env file against its template. Collects every problem rather than
 * failing on the first, so one run tells you everything that is wrong.
 */
async function checkEnv(root: string, entry: EnvFile) {
  const file = entry.file ?? ".env";
  const example = entry.example ?? `${file}.example`;
  const path = resolve(root, file);
  const examplePath = resolve(root, example);

  if (!existsSync(path)) return [`${file} is missing`];
  if (!existsSync(examplePath)) return [];

  const actual = parseEnv(await Bun.file(path).text());
  const required = parseEnv(await Bun.file(examplePath).text());

  const missing = [...required.keys()].filter((key) => !actual.has(key));
  const blank = [...required.keys()].filter((key) => actual.get(key) === "");

  const problems: string[] = [];
  if (missing.length) problems.push(`${file} is missing keys: ${missing.join(", ")}`);
  // Blank values are the dangerous case: the app starts, then fails later in a way that
  // looks like an unrelated bug. Hosts storing secrets write-only hand them back exactly so.
  if (blank.length) problems.push(`${file} has empty values: ${blank.join(", ")}`);
  if (!problems.length) console.log(`  ${file} ok (${actual.size} vars)`);
  return problems;
}

export async function runSetup(dry = false) {
  const root = process.cwd();
  const setup: SetupConfig = loadConfig(root).setup ?? {};
  const envFiles = setup.env ?? [{ file: ".env" }];

  const run = async (command: string, cwd = root) => {
    if (dry) return console.log(`  $ ${command}`);
    await $`sh -c ${command}`.cwd(cwd);
  };

  console.log("Checking env files…");
  const problems = (await Promise.all(envFiles.map((entry) => checkEnv(root, entry)))).flat();

  if (problems.length) {
    console.error(`\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
    console.error("\nRun `devkit secrets pull` to fetch them, or copy them from another machine.");
    process.exit(1);
  }

  if (setup.install !== false) await run("bun install");

  if (setup.terraform) {
    const dir = resolve(root, setup.terraform);
    if (existsSync(resolve(dir, "terraform.tfvars"))) await run("terraform init -input=false", dir);
    else console.log(`Skipping terraform init — no ${setup.terraform}/terraform.tfvars.`);
  }

  for (const step of setup.steps ?? []) await run(step);

  console.log(dry ? "\nDry run — nothing executed." : "\nSetup complete.");
}
