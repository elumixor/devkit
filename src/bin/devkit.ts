#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { loadConfig } from "../config.ts";
import { runDeploy } from "../deploy.ts";
import { deployFastlaneIos } from "../deploy-targets/fastlane-ios.ts";
import { deployTauriMacos } from "../deploy-targets/tauri-macos.ts";
import { deployVercel } from "../deploy-targets/vercel.ts";
import { runDev } from "../dev.ts";
import { runSetup } from "../setup.ts";
import { runClone } from "../clone.ts";
import { pullSecrets, pushSecrets } from "../secrets.ts";
import pkg from "../../package.json" with { type: "json" };

const { values, positionals } = parseArgs({
  options: {
    open: { type: "boolean", default: false },
    dry: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
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
       devkit deploy [targets...]          run the configured deploys, in parallel
       devkit secrets push|pull [root]     sync age-encrypted secrets

  root      path to the folder holding the devkit config (default: cwd)
  --open    open each app's URL in the browser once its port is live
  --dry     print what would run without running it
  --verbose stream every line instead of drawing the live board (deploy)
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
    case "deploy": {
      await runDeploy(rest, { dry: values.dry, verbose: values.verbose });
      break;
    }
    // Internal: how a built-in `type`d deploy target actually runs — spawned as its own process
    // by `runDeploy` so it gets the same line-capture and log file as a hand-written `command`.
    case "_deploy-target": {
      const [name] = rest;
      const { deploy } = loadConfig();
      const target = deploy.find((t) => t.name === name);
      if (!target?.type) throw new Error(`No deploy target ${name} with a "type"`);
      if (target.type === "vercel") await deployVercel(target.options);
      else if (target.type === "tauri-macos") await deployTauriMacos(target.options);
      else if (target.type === "fastlane-ios") await deployFastlaneIos(target.options);
      else throw new Error(`Unknown deploy target type: ${target.type}`);
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
