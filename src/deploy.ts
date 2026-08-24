import { loadConfig } from "./config.ts";
import { type GraphOptions, runGraph } from "./graph.ts";

/** Deploy every configured platform, in parallel where they don't depend on each other. */
export async function runDeploy(only: string[], options: GraphOptions = {}) {
  const { deploy, generate } = loadConfig();
  await runGraph("deploy", deploy, only, generate, options);
}
