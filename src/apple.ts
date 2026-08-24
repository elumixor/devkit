import { watch } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";

/** What every Apple target here needs to name a build: which project, which scheme, where to. */
export interface XcodeBuild {
  /** Path to the `.xcodeproj`, relative to the root. */
  project: string;
  /** Scheme to build; also the name of the built `.app`. */
  scheme: string;
  /** `Debug` or `Release` (default `Debug`). */
  configuration?: string;
  /** Simulator SDK to build against (default `iphonesimulator`). */
  sdk?: string;
  /** Derived data dir, relative to the root (default `build/<scheme>`). */
  derivedDataDir?: string;
}

/** Where a built product lands, given the same options the build was given. */
export function productPath(options: XcodeBuild, root = process.cwd()) {
  const configuration = options.configuration ?? "Debug";
  const sdk = options.sdk ?? "iphonesimulator";
  const derived = resolve(root, options.derivedDataDir ?? `build/${options.scheme}`);
  return join(derived, "Build/Products", `${configuration}-${sdk}`, `${options.scheme}.app`);
}

/**
 * Compiles a scheme for a simulator.
 *
 * Signing is off: a simulator runs unsigned code, and asking for a certificate would make a build
 * that only tells you whether the app compiles fail on a machine that has never seen the team's
 * provisioning profiles.
 */
export async function xcodeBuild(options: XcodeBuild & { destination?: string }) {
  const root = process.cwd();
  const project = resolve(root, options.project);
  if (!existsSync(project)) throw new Error(`No Xcode project at ${project}`);
  const configuration = options.configuration ?? "Debug";
  const sdk = options.sdk ?? "iphonesimulator";
  const derived = resolve(root, options.derivedDataDir ?? `build/${options.scheme}`);
  const destination = options.destination ?? `generic/platform=${sdk === "watchsimulator" ? "watchOS" : "iOS"} Simulator`;

  // The destination says which SDK each target compiles against, and `-sdk` would override that
  // for all of them at once — which is how an iPhone build of a project that embeds a watch app
  // ends up compiling the watch widget for iOS and failing on its deployment target.
  await $`xcodebuild -project ${project} -scheme ${options.scheme} -configuration ${configuration} \
    -destination ${destination} -derivedDataPath ${derived} \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build`;
}

/** Boots the named simulator if it isn't already up, and returns its device id. */
export async function bootSimulator(deviceName: string) {
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

/** Replaces whatever copy of the app is on the simulator with this one, and starts it. */
export async function installAndLaunch(udid: string, appPath: string, bundleId: string, env: Record<string, string> = {}) {
  if (!existsSync(appPath)) throw new Error(`No app bundle at ${appPath}`);
  await $`xcrun simctl terminate ${udid} ${bundleId}`.nothrow().quiet();
  await $`xcrun simctl install ${udid} ${appPath}`;
  // `SIMCTL_CHILD_` is how simctl passes an environment on to the app it launches.
  const child = Object.fromEntries(Object.entries(env).map(([key, value]) => [`SIMCTL_CHILD_${key}`, value]));
  await $`xcrun simctl launch ${udid} ${bundleId}`.env({ ...process.env, ...child });
}

/**
 * Rebuilds and relaunches whenever native sources change, and never returns.
 *
 * Swift has no hot reload, so this is what "live" means on the native side: the edit-to-app loop
 * is one save long instead of a trip through Xcode. The web half of a Capacitor app doesn't come
 * through here at all — Vite already replaced it in the running webview.
 */
export async function rerunOnChange(dirs: string[], run: () => Promise<void>) {
  let running = false;
  let again = false;

  const cycle = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await run();
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
    running = false;
    if (again) {
      again = false;
      void cycle();
    }
  };

  let pending: ReturnType<typeof setTimeout> | undefined;
  for (const dir of dirs) {
    const path = resolve(process.cwd(), dir);
    if (!existsSync(path)) continue;
    watch(path, { recursive: true }, (_event, file) => {
      // Xcode and SPM write into these trees constantly; only sources are worth a rebuild.
      if (file && !/\.(swift|m|h|plist|entitlements|xcconfig|storyboard|xib)$/.test(file)) return;
      clearTimeout(pending);
      pending = setTimeout(() => void cycle(), 300);
    });
  }

  if (dirs.length) console.log(`Watching ${dirs.join(", ")} — saving a source file rebuilds and relaunches`);
  // A dev process that ends kills the ones running beside it, so this one stays up until Ctrl-C.
  await new Promise<never>(() => {});
}
