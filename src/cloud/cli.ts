import { bootstrap } from "./bootstrap.ts";
import { destroy } from "./commands/destroy.ts";
import { domains } from "./commands/domains.ts";
import { env } from "./commands/env.ts";
import { init } from "./commands/init.ts";
import { logs } from "./commands/logs.ts";
import { rollback } from "./commands/rollback.ts";
import { deploys, status } from "./commands/status.ts";

export interface CloudFlags {
  stage?: string;
  since?: string;
  grep?: string;
  follow?: boolean;
  to?: string;
  email?: string;
}

export const CLOUD_USAGE = `usage: devkit cloud bootstrap [--email x]      once per account: buckets, edge, roles, budgets
       devkit cloud init                      once per repo: aws deploy target + GitHub workflow
       devkit cloud status [project]          live deploy per stage, calls and errors for 24 h
       devkit cloud deploys <project> [--stage s]
       devkit cloud logs [project] [--stage s] [--since 1h] [--grep x] [--follow]
       devkit cloud rollback <project> [--stage s] [--to <deployId>]
       devkit cloud env ls|pull|push|set|rm [--stage s]
       devkit cloud domains ls|add|rm <project> [host] [--stage s]
       devkit cloud destroy <project> --stage s`;

/** `devkit cloud <command> ...` */
export function runCloud(args: readonly string[], flags: CloudFlags) {
  const [command, ...rest] = args;
  switch (command) {
    case "bootstrap":
      return bootstrap({ email: flags.email });
    case "init":
      return init();
    case "status":
      return status(rest[0]);
    case "deploys":
      if (!rest[0]) throw new Error("usage: devkit cloud deploys <project> [--stage s]");
      return deploys(rest[0], flags.stage);
    case "logs":
      return logs(rest[0], { stage: flags.stage, since: flags.since, grep: flags.grep, follow: flags.follow });
    case "rollback":
      if (!rest[0]) throw new Error("usage: devkit cloud rollback <project> [--stage s] [--to <deployId>]");
      return rollback(rest[0], flags.stage, flags.to);
    case "env":
      return env(rest[0], rest.slice(1), flags.stage);
    case "domains":
      return domains(rest[0], rest[1], rest[2], flags.stage);
    case "destroy":
      return destroy(rest[0], flags.stage);
    default:
      throw new Error(`Unknown cloud command "${command ?? ""}"\n\n${CLOUD_USAGE}`);
  }
}
