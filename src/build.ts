import { loadConfig } from "./config.ts";
import { type GraphOptions, runGraph } from "./graph.ts";

/** Build every configured platform at once, or only the ones named. */
export async function runBuild(only: string[], options: GraphOptions = {}) {
  const { build, generate } = loadConfig();
  await runGraph("build", build, only, generate, options);
}
