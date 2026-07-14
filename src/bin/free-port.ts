#!/usr/bin/env bun
import { freePort } from "../free-port.ts";

const port = process.argv[2];
if (!port) {
  console.error("usage: free-port <port>");
  process.exit(1);
}

await freePort(port);
