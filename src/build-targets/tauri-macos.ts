import { $ } from "bun";
import { isolatedWebEnv } from "../web-build.ts";

export interface TauriMacosBuildOptions {
  /** Tauri project dir, holding `src-tauri` (default `apps/frontend`). */
  frontendDir?: string;
  /** Bundles to produce (default `app` — the `.app`, which is what a check needs). */
  bundles?: string;
  /** Suffix for this build's own web output, kit and cache dirs (default `mac`). */
  webSuffix?: string;
}

/**
 * Builds the macOS app, and nothing else: no Developer ID, no notarization, no install.
 *
 * This is the build that answers "does the Mac shell still compile against this frontend" while
 * the other platforms are answering the same question for themselves. Signing and shipping belong
 * to the `tauri-macos` *deploy* target, which does its own release build.
 */
export async function buildTauriMacos(options: TauriMacosBuildOptions = {}) {
  const frontendDir = options.frontendDir ?? "apps/frontend";
  const bundles = options.bundles ?? "app";
  const suffix = options.webSuffix ?? "mac";
  const env = isolatedWebEnv(suffix);

  // Tauri reads `frontendDist` from its own config file, which has no environment override — so
  // the directory the isolated web build writes into is pointed at through a config overlay.
  const overlay = JSON.stringify({ build: { frontendDist: `../${env.BUILD_DIR}` } });

  await $`bunx tauri build --bundles ${bundles} --config ${overlay}`.cwd(frontendDir).env({
    ...process.env,
    ...env,
    // macOS refuses an unsigned bundle outright; ad-hoc is enough for a build nobody downloads.
    APPLE_SIGNING_IDENTITY: "-",
  });
}
