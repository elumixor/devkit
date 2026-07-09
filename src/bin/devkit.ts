#!/usr/bin/env bun
import { runDev } from "../dev.ts";

const [command, ...rest] = process.argv.slice(2);

if (command !== "dev") {
  console.error("usage: devkit dev [--open] [--dry]");
  process.exit(1);
}

await runDev(rest.includes("--open"), rest.includes("--dry"));
