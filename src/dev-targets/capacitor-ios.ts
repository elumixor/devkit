import { join } from "node:path";
import { $ } from "bun";
import { bootSimulator, installAndLaunch, productPath, rerunOnChange, type XcodeBuild, xcodeBuild } from "../apple.ts";
import { waitForPort } from "../wait-port.ts";

export interface CapacitorIosDevOptions extends XcodeBuild {
  /** Capacitor dir, holding `capacitor.config.ts` and `ios/` (default `apps/frontend`). */
  frontendDir?: string;
  /** Bundle id to install and launch. */
  bundleId: string;
  /** Simulator to run on — overridable with `--device` or `DEVKIT_SIM_DEVICE`. */
  device: string;
  /** Port the web dev server listens on, waited for before the app is launched (default 8081). */
  port?: number;
  /** Env var the Capacitor config reads to point the webview at the dev server. */
  liveReloadEnv?: string;
  /** Native source dirs that, when saved, rebuild and relaunch the app. */
  watch?: string[];
}

/**
 * Runs the iPhone app on a simulator against the running dev server.
 *
 * The webview loads the page over the network rather than from the bundle, so every web edit is
 * already live by the time it lands — `cap sync` here copies the plugins and the configuration,
 * not the app. Native edits still need a compile, which is what the watch at the end is for.
 */
export async function devCapacitorIos(options: CapacitorIosDevOptions, flags: { device?: string } = {}) {
  const frontendDir = options.frontendDir ?? "apps/frontend";
  const deviceName = flags.device ?? process.env.DEVKIT_SIM_DEVICE ?? options.device;
  const port = options.port ?? 8081;
  const sdk = options.sdk ?? "iphonesimulator";
  const build = { ...options, sdk };

  // Syncing before the server is up would bake a URL nothing answers on into the webview, and the
  // app would open on a blank page until it is restarted by hand.
  if (!(await waitForPort(port))) throw new Error(`Nothing came up on port ${port} — is the web dev server running?`);

  await $`bunx cap sync ios`.cwd(frontendDir).env({
    ...process.env,
    [options.liveReloadEnv ?? "CAPACITOR_LIVE_RELOAD"]: "true",
  });

  const udid = await bootSimulator(deviceName);

  const launch = async () => {
    await xcodeBuild({ ...build, destination: `id=${udid}` });
    await installAndLaunch(udid, productPath(build), options.bundleId);
    console.log(`${options.scheme} running on ${deviceName}, loading http://<lan>:${port}`);
  };

  await launch();
  await rerunOnChange(options.watch ?? [join(frontendDir, "ios/App/App")], launch);
}
