#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { runDev } from "../dev.ts";
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

if (values.help) {
  console.log("usage: devkit [root] [--open] [--dry] [--version]\n");
  console.log("  root      path to the folder holding the devkit config (default: cwd)");
  console.log("  --open    open each app's URL in the browser once its port is live");
  console.log("  --dry     print the resolved commands and URLs without running anything");
  console.log("  --version print the devkit version");
  process.exit(0);
}

// Optional positional: the monorepo root. Operate as if launched from there.
const root = positionals[0];
if (root) process.chdir(resolve(root));

await runDev(values.open, values.dry);
