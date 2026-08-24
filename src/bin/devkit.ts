#!/usr/bin/env bun
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import { runBuild } from "../build.ts";
import { runClone } from "../clone.ts";
import { PHASES, type Phase } from "../config.ts";
import { runDeploy } from "../deploy.ts";
import { runDev } from "../dev.ts";
import { runRelease } from "../release.ts";
import { runTarget } from "../run-target.ts";
import { pullSecrets, pushSecrets } from "../secrets.ts";
import { runSetup } from "../setup.ts";
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

const usage = `usage: devkit dev [platforms...]           run the dev processes (default)
       devkit dev:<platform>               run one platform, and whatever it needs
       devkit build [platforms...]         build every platform, in parallel
       devkit build:<platform>             build one platform
       devkit deploy [platforms...]        deploy every platform, in dependency order
       devkit deploy:<platform>            deploy one platform
       devkit setup [root] [--dry]         validate secrets, install, terraform init, run steps
       devkit clone <owner/repo> [dir]     clone, decrypt secrets, set up
       devkit version                      write the source version into every file that declares one
       devkit release <prefix>             tag this commit <prefix>-v<timestamp> and push it
       devkit secrets push|pull [root]     sync age-encrypted secrets

  Platforms are whatever "devkit.dev", "devkit.build" and "devkit.deploy" name in package.json —
  typically web, mac, iphone, iwatch. Naming one also runs the platforms it declares in "needs".

  --open    open each dev process's URL in the browser once its port is live
  --dry     print what would run without running it
  --verbose stream every line instead of drawing the live board (build, deploy)
  --real    run a simulator against the real API instead of sample data
  --device  simulator to run on, overriding the configured one
  --version print the devkit version`;

if (values.help) {
  console.log(usage);
  process.exit(0);
}

const [head, ...rest] = positionals;
// `devkit build:mac` and `devkit build mac` are the same thing — a colon is what a package.json
// script reads best, a positional is what a shell completes best.
const [command, suffix] = (head ?? "dev").split(":");
const platforms = [...(suffix ? [suffix] : []), ...(isPhase(command) ? rest : [])];

function isPhase(name: string | undefined): name is Phase {
  return PHASES.includes(name as Phase);
}

function chdirTo(dir?: string) {
  if (dir) process.chdir(resolve(dir));
}

try {
  switch (command) {
    case "dev": {
      await runDev(platforms, { open: values.open, dry: values.dry });
      break;
    }
    case "build": {
      await runBuild(platforms, { dry: values.dry, verbose: values.verbose });
      break;
    }
    case "deploy": {
      await runDeploy(platforms, { dry: values.dry, verbose: values.verbose });
      break;
    }
    // Internal: how a `type`d step actually runs — spawned as its own process by the graph (or by
    // `concurrently`, for dev) so it gets that step's own line on the board and its own log file.
    case "_run": {
      const [phase, name] = rest;
      if (!isPhase(phase) || !name) throw new Error("usage: devkit _run <phase> <platform>");
      await runTarget(phase, name, { real: values.real, device: values.device });
      break;
    }
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
    case "version": {
      await runVersion();
      break;
    }
    case "release": {
      await runRelease(rest[0] ?? "");
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
    default:
      throw new Error(`Unknown command "${head}"\n\n${usage}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
