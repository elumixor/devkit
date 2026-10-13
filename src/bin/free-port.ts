#!/usr/bin/env bun
import { freePort } from "../free-port.ts";

const port = process.argv[2];
if (!port) {
  console.error("usage: free-port <port>");
  process.exit(1);
}

const killed = await freePort(port);
console.log(killed.length ? `✓ Freed port ${port} (killed ${killed.join(", ")})` : `✓ Port ${port} already free`);
