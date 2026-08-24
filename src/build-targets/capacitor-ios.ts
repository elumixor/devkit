import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { type XcodeBuild, xcodeBuild } from "../apple.ts";
import { isolatedWebEnv } from "../web-build.ts";

export interface CapacitorIosBuildOptions extends XcodeBuild {
  /** Capacitor dir, holding `capacitor.config.ts` and `ios/` (default `apps/frontend`). */
  frontendDir?: string;
  /** iOS project dir (default `<frontendDir>/ios`). */
  iosDir?: string;
  /** Suffix for this build's own web output, kit and cache dirs (default `ios`). */
  webSuffix?: string;
}

/**
 * Builds the web bundle, syncs it into the Xcode project and compiles the iOS app for a
 * simulator — the whole chain a TestFlight release goes through, minus the signing and the upload.
 */
export async function buildCapacitorIos(options: CapacitorIosBuildOptions) {
  const frontendDir = options.frontendDir ?? "apps/frontend";
  const iosDir = options.iosDir ?? join(frontendDir, "ios");
  const env = { ...process.env, ...isolatedWebEnv(options.webSuffix ?? "ios") };

  await $`bun run build`.cwd(frontendDir).env(env);
  await $`bunx cap sync ios`.cwd(frontendDir).env(env);

  // `cap sync` reports a failed copy and still exits 0, which would compile whatever web assets
  // the project happened to be carrying from a previous build.
  const bundled = join(iosDir, "App/App/public/index.html");
  if (!existsSync(bundled)) throw new Error(`cap sync didn't copy the web build — no ${bundled}`);

  await xcodeBuild(options);
}
