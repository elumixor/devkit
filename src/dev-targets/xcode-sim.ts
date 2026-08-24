import { bootSimulator, installAndLaunch, productPath, rerunOnChange, type XcodeBuild, xcodeBuild } from "../apple.ts";

export interface XcodeSimOptions extends XcodeBuild {
  /** Bundle id to install and launch. */
  bundleId: string;
  /** Simulator to run on — overridable with `--device` or `DEVKIT_SIM_DEVICE`. */
  device: string;
  /** Env var the app reads to show sample data; set unless `--real` is passed. */
  previewEnv?: string;
  /** Source dirs that, when saved, rebuild and relaunch the app. */
  watch?: string[];
}

/**
 * Build an Apple app and run it on a simulator, without going through Xcode, then keep rebuilding
 * it as its sources change.
 *
 * A watch app usually has no sign-in of its own, so on a simulator with no paired phone it can
 * only show its signed-out screen. `previewEnv` launches it with the app's own preview flag set
 * instead, which is the point of running it here at all: gestures have to be felt.
 */
export async function devXcodeSim(options: XcodeSimOptions, flags: { real?: boolean; device?: string } = {}) {
  const deviceName = flags.device ?? process.env.DEVKIT_SIM_DEVICE ?? options.device;
  const preview = !flags.real;
  const sdk = options.sdk ?? "watchsimulator";
  const build = { ...options, sdk };

  const udid = await bootSimulator(deviceName);

  const launch = async () => {
    await xcodeBuild({ ...build, destination: `id=${udid}` });
    await installAndLaunch(
      udid,
      productPath(build),
      options.bundleId,
      preview && options.previewEnv ? { [options.previewEnv]: "1" } : {},
    );
    console.log(`${options.scheme} running on ${deviceName}${preview && options.previewEnv ? " with sample data" : ""}`);
  };

  await launch();
  await rerunOnChange(options.watch ?? [], launch);
}
