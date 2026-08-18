import { resolve } from "node:path";
import { $ } from "bun";

export interface VercelTargetOptions {
  /** Project root, relative to the config's directory (default `.`). */
  cwd?: string;
}

/**
 * Builds here and uploads the finished output, rather than handing Vercel the repo and waiting
 * for it to build the same thing again.
 */
export async function deployVercel(options: VercelTargetOptions = {}) {
  // Bun's `$` resolves a "." cwd wrong (chases a literal "undefined" path segment) — pass it an
  // absolute path instead.
  const cwd = resolve(options.cwd ?? ".");
  await $`bunx vercel build --prod --yes`.cwd(cwd);

  // The upload is the one part of a release that a flaky minute of home internet can end — the
  // CLI waits on the deployment over the network and gives up when the connection does, whatever
  // the deployment itself went on to do.
  await retry(() => $`bunx vercel deploy --prebuilt --prod --yes`.cwd(cwd));
}

async function retry<T>(attempt: () => Promise<T>, times = 3): Promise<T> {
  for (let remaining = times - 1; ; remaining--) {
    try {
      return await attempt();
    } catch (error) {
      if (remaining <= 0) throw error;
      console.log(`Deploy failed, retrying (${remaining} left)`);
    }
  }
}
