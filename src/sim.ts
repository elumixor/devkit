import { resolve } from "node:path";
import { $ } from "bun";
import { loadConfig } from "./config.ts";

/**
 * Build an Apple app and run it on a simulator, without going through Xcode.
 *
 * A watch app usually has no sign-in of its own, so on a simulator with no paired phone it can
 * only show its signed-out screen. `preview` launches it with the app's own preview flag set
 * instead, which is the point of running it here at all: gestures have to be felt.
 */
export async function runSim(options: { real?: boolean; device?: string } = {}) {
  const { sim } = loadConfig();
  if (!sim) throw new Error('No "devkit.sim" config in package.json');

  const project = resolve(process.cwd(), sim.project);
  const derived = resolve(process.cwd(), sim.derivedDataDir ?? "build/sim");
  const sdk = sim.sdk ?? "watchsimulator";
  const deviceName = options.device ?? process.env.DEVKIT_SIM_DEVICE ?? sim.device;
  const preview = !options.real;

  const udid = await boot(deviceName);

  await $`xcodebuild -project ${project} -scheme ${sim.scheme} -configuration Debug \
    -destination id=${udid} -derivedDataPath ${derived} build`.quiet();

  await $`xcrun simctl install ${udid} ${derived}/Build/Products/Debug-${sdk}/${sim.scheme}.app`;
  await $`xcrun simctl terminate ${udid} ${sim.bundleId}`.nothrow().quiet();
  // `SIMCTL_CHILD_` is how simctl passes an environment on to the app it launches.
  await $`xcrun simctl launch ${udid} ${sim.bundleId}`.env({
    ...process.env,
    ...(preview && sim.previewEnv ? { [`SIMCTL_CHILD_${sim.previewEnv}`]: "1" } : {}),
  });

  console.log(`${sim.scheme} running on ${deviceName}${preview && sim.previewEnv ? " with sample data" : ""}`);
}

/** Boots the simulator if it isn't already up, and returns its device id. */
async function boot(deviceName: string) {
  const { devices } = await $`xcrun simctl list devices available -j`.quiet().json();
  // The same model exists once per installed runtime; the newest one is the one to use.
  const runtimes = Object.keys(devices).sort().reverse();
  const match = runtimes
    .flatMap((runtime) => devices[runtime] as { name: string; udid: string; state: string }[])
    .find((device) => device.name === deviceName);

  if (!match) throw new Error(`No simulator called "${deviceName}" — see \`xcrun simctl list devices available\``);
  if (match.state !== "Booted") await $`xcrun simctl boot ${match.udid}`;
  await $`open -a Simulator`;
  return match.udid;
}
