#!/usr/bin/env bun
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import { runBuild } from "../build.ts";
import { runClone } from "../clone.ts";
import { loadConfig } from "../config.ts";
import { runDeploy } from "../deploy.ts";
import { deployFastlaneIos } from "../deploy-targets/fastlane-ios.ts";
import { deployTauriMacos } from "../deploy-targets/tauri-macos.ts";
import { deployVercel } from "../deploy-targets/vercel.ts";
import { runDev } from "../dev.ts";
import { runRelease } from "../release.ts";
import { pullSecrets, pushSecrets } from "../secrets.ts";
import { runSetup } from "../setup.ts";
import { runSim } from "../sim.ts";
import { runVersion } from "../version.ts";

const { values, positionals } = parseArgs({
  options: {
    open: { type: "boolean", default: false },
    real: { type: "boolean", default: false },
    device: { type: "string" },
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
       devkit build                        build the web app and the API into one Vercel output
       devkit sim [--real] [--device n]    build and launch the app on a simulator
       devkit version                      write the source version into every file that declares one
       devkit release <prefix>             tag this commit <prefix>-v<timestamp> and push it
       devkit secrets push|pull [root]     sync age-encrypted secrets

  root      path to the folder holding the devkit config (default: cwd)
  --open    open each app's URL in the browser once its port is live
  --dry     print what would run without running it
  --verbose stream every line instead of drawing the live board (deploy)
  --real    run the simulator build against the real API instead of sample data
  --device  simulator to run on, overriding the configured one
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
    case "build": {
      await runBuild();
      break;
    }
    case "sim": {
      await runSim({ real: values.real, device: values.device });
      break;
    }
    case "version": {
      await runVersion();
      break;
    }
    case "release": {
      await runRelease(rest[0] ?? "");
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
