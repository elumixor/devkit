#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { runDev } from "../dev.ts";
import { runSetup } from "../setup.ts";
import { runClone } from "../clone.ts";
import { pullSecrets, pushSecrets } from "../secrets.ts";
import pkg from "../../package.json" with { type: "json" };

const { values, positionals } = parseArgs({
  options: {
    open: { type: "boolean", default: false },
    dry: { type: "boolean", default: false },
    version: { type: "boolean", short: "v", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

if (values.version) {
  console.log(pkg.version);
  process.exit(0);
}

const usage = `usage: devkit [root] [--open] [--dry]      run the dev processes (default)
       devkit clone <owner/repo> [dir]     clone, decrypt secrets, set up
       devkit setup [root] [--dry]         validate secrets, install, terraform init, run steps
       devkit secrets push|pull [root]     sync age-encrypted secrets

  root      path to the folder holding the devkit config (default: cwd)
  --open    open each app's URL in the browser once its port is live
  --dry     print what would run without running it
  --version print the devkit version`;

if (values.help) {
  console.log(usage);
  process.exit(0);
}

const [command, ...rest] = positionals;

function chdirTo(dir?: string) {
  if (dir) process.chdir(resolve(dir));
}

try {
  switch (command) {
    case "clone": {
      const [repo, dir] = rest;
      if (!repo) throw new Error("usage: devkit clone <owner/repo> [dir]");
      await runClone(repo, dir);
      break;
    }
    case "setup": {
      chdirTo(rest[0]);
      await runSetup(values.dry);
      break;
    }
    case "secrets": {
      const [action, dir] = rest;
      chdirTo(dir);
      if (action === "push") await pushSecrets();
      else if (action === "pull") await pullSecrets();
      else throw new Error("usage: devkit secrets push|pull [root]");
      break;
    }
    default: {
      // No subcommand — the original `devkit [root]` behaviour.
      chdirTo(command);
      await runDev(values.open, values.dry);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
