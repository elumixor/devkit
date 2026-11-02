import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { bold, dim } from "../../ansi.ts";
import { CloudError, log } from "../aws.ts";
import { deleteStageVariable, formatDotenv, parseDotenv, readStageEnv, writeStageEnv } from "../env.ts";
import { targetFromRepo } from "./context.ts";

const DOTENV = ".env";

/** `devkit cloud env ls|pull|push|set|rm`: the stage's variables in SSM, as the root `.env` sees them. */
export async function env(action: string | undefined, args: readonly string[], stageFlag: string | undefined) {
  const target = await targetFromRepo(stageFlag);
  const label = `${target.project} ${target.stage}`;

  switch (action) {
    case "ls": {
      const current = await readStageEnv(target);
      const keys = Object.keys(current).sort();
      if (!keys.length) return log(`No variables for ${label}`);
      log(bold(label));
      for (const key of keys) log(`  ${key.padEnd(32)} ${dim(mask(current[key] as string))}`);
      return;
    }
    case "pull": {
      const file = resolve(args[0] ?? DOTENV);
      await Bun.write(file, formatDotenv(await readStageEnv(target)));
      return log(`Wrote ${label} to ${args[0] ?? DOTENV}`);
    }
    case "push": {
      const file = resolve(args[0] ?? DOTENV);
      if (!existsSync(file)) throw new CloudError(`No ${args[0] ?? DOTENV} to push`);
      const values = parseDotenv(await Bun.file(file).text());
      await writeStageEnv(target, values);
      return log(`Pushed ${Object.keys(values).length} variables to ${label}`);
    }
    case "set": {
      const pairs = args.map((arg) => {
        const at = arg.indexOf("=");
        if (at <= 0) throw new CloudError(`"${arg}" is not KEY=value`);
        return [arg.slice(0, at), arg.slice(at + 1)] as const;
      });
      if (!pairs.length) throw new CloudError("usage: devkit cloud env set KEY=value [KEY=value...]");
      await writeStageEnv(target, Object.fromEntries(pairs));
      return log(`Set ${pairs.map(([key]) => key).join(", ")} on ${label}`);
    }
    case "rm": {
      if (!args.length) throw new CloudError("usage: devkit cloud env rm KEY [KEY...]");
      for (const key of args) await deleteStageVariable(target, key);
      return log(`Removed ${args.join(", ")} from ${label}`);
    }
    default:
      throw new CloudError("usage: devkit cloud env ls|pull [file]|push [file]|set KEY=value...|rm KEY... [--stage s]");
  }
}

function mask(value: string) {
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 3)}${"•".repeat(Math.min(12, value.length - 5))}${value.slice(-2)}`;
}
