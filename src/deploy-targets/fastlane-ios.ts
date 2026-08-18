import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

export interface FastlaneIosTargetOptions {
  /** Capacitor/frontend dir (default `apps/frontend`). */
  frontendDir?: string;
  /** Backend dir to generate a typed API client from before building, if any. */
  backendDir?: string;
  /** iOS project dir (default `<frontendDir>/ios`). */
  iosDir?: string;
  /** Fastlane lane to run (default `beta`). */
  lane?: string;
  /** API base URL the build embeds, unless `apiBaseUrlEnv` is already set. */
  defaultApiBaseUrl: string;
  /** Env var an override is read from, and passed to the build as `VITE_API_BASE_URL` (default `DEPLOY_API_BASE_URL`). */
  apiBaseUrlEnv?: string;
  keyIdEnv?: string;
  issuerIdEnv?: string;
  keyPathEnv?: string;
}

/**
 * Builds the web bundle against the deployed API, syncs it into the Xcode project and hands the
 * archive to fastlane, which signs the app, the watch app and the widget and uploads to
 * TestFlight.
 */
export async function deployFastlaneIos(options: FastlaneIosTargetOptions) {
  const frontendDir = options.frontendDir ?? "apps/frontend";
  const iosDir = options.iosDir ?? join(frontendDir, "ios");
  const lane = options.lane ?? "beta";
  const apiBaseUrlEnv = options.apiBaseUrlEnv ?? "DEPLOY_API_BASE_URL";
  const apiBaseUrl = process.env[apiBaseUrlEnv] ?? options.defaultApiBaseUrl;

  const keyIdEnv = options.keyIdEnv ?? "APP_STORE_CONNECT_API_KEY_ID";
  const issuerIdEnv = options.issuerIdEnv ?? "APP_STORE_CONNECT_API_KEY_ISSUER_ID";
  const keyPathEnvName = options.keyPathEnv ?? "APP_STORE_CONNECT_API_KEY_PATH";

  // fastlane needs a modern Ruby; macOS still ships 2.6, which its gems no longer install against.
  // `bundle` is called by full path because Bun's shell resolves a command against its own PATH
  // before the env below is applied, and would find /usr/bin/bundle — the system Ruby's.
  const rubyBin = "/opt/homebrew/opt/ruby/bin";
  const bundle = join(rubyBin, "bundle");
  if (!existsSync(bundle)) throw new Error("No Homebrew Ruby at /opt/homebrew/opt/ruby — `brew install ruby`");

  const keyPath = process.env[keyPathEnvName] ?? join(homedir(), ".appstoreconnect/private_keys", `AuthKey_${required(keyIdEnv)}.p8`);
  const env = {
    ...process.env,
    PATH: `${rubyBin}:${process.env.PATH}`,
    [keyIdEnv]: required(keyIdEnv),
    [issuerIdEnv]: required(issuerIdEnv),
    [keyPathEnvName]: keyPath,
    FASTLANE_SKIP_UPDATE_CHECK: "1",
    FASTLANE_HIDE_CHANGELOG: "1",
  };
  if (!existsSync(keyPath)) throw new Error(`No App Store Connect key at ${keyPath}`);

  // Same order as a web deploy: the typed client is generated from the routes the app compiles
  // against. A `deploy` running every target generates it once up front, because two builds
  // writing those files at the same time is the one thing running in parallel can't survive.
  if (options.backendDir && !process.env.SKIP_CLIENT_GEN) await $`bunx nitro-client`.cwd(options.backendDir);

  // The web build a release ships to Vercel is happening in the next directory over, against the
  // same sources — this one gets its own output, cache and Capacitor web root so neither sees half
  // of the other's build.
  const buildEnv = {
    ...process.env,
    VITE_API_BASE_URL: apiBaseUrl,
    BUILD_DIR: "build-ios",
    KIT_DIR: ".svelte-kit-ios",
    VITE_CACHE_DIR: "node_modules/.vite-ios",
  };
  await $`bun run build`.cwd(frontendDir).env(buildEnv);
  await $`bunx cap sync ios`.cwd(frontendDir).env(buildEnv);

  // `cap sync` reports a failed copy and still exits 0, which would archive whatever web assets the
  // project happened to be carrying from a previous build.
  const bundled = join(iosDir, "App/App/public/index.html");
  if (!existsSync(bundled)) throw new Error(`cap sync didn't copy the web build — no ${bundled}`);

  const installed = await $`${bundle} check`.cwd(iosDir).env(env).nothrow().quiet();
  if (installed.exitCode !== 0) await $`${bundle} install`.cwd(iosDir).env(env);
  await $`${bundle} exec fastlane ${lane}`.cwd(iosDir).env(env);
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing — put it in the repo's .env`);
  return value;
}
