import { buildCapacitorIos } from "./build-targets/capacitor-ios.ts";
import { buildTauriMacos } from "./build-targets/tauri-macos.ts";
import { buildWeb } from "./build-targets/web.ts";
import { buildXcode } from "./build-targets/xcode.ts";
import { loadConfig, type Phase, phaseOf } from "./config.ts";
import { deployFastlaneIos } from "./deploy-targets/fastlane-ios.ts";
import { deployTauriMacos } from "./deploy-targets/tauri-macos.ts";
import { deployVercel } from "./deploy-targets/vercel.ts";
import { devCapacitorIos } from "./dev-targets/capacitor-ios.ts";
import { devXcodeSim } from "./dev-targets/xcode-sim.ts";

/** Flags a dev target may be given from the command line, passed straight through to it. */
export interface TargetFlags {
  real?: boolean;
  device?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: each target validates its own options shape
type Target = (options: any, flags: TargetFlags) => Promise<void>;

/**
 * What a `type` in the config means, per phase.
 *
 * The same word means different things in different phases on purpose: `capacitor-ios` builds the
 * iPhone app when a build asks for it, runs it against the dev server when dev does, and ships it
 * to TestFlight when a deploy does. The platform is the name; the phase says what to do with it.
 */
const TARGETS: Record<Phase, Record<string, Target>> = {
  dev: {
    "capacitor-ios": devCapacitorIos,
    "xcode-sim": devXcodeSim,
  },
  build: {
    web: buildWeb,
    "tauri-macos": buildTauriMacos,
    "capacitor-ios": buildCapacitorIos,
    xcode: buildXcode,
  },
  deploy: {
    vercel: deployVercel,
    "tauri-macos": deployTauriMacos,
    "fastlane-ios": deployFastlaneIos,
  },
};

/**
 * Runs one built-in target, looked back up by phase and platform name.
 *
 * A typed step has no shell command of its own, so the graph (and `concurrently`, for dev) spawns
 * `devkit _run <phase> <platform>` and this reads the same config back — which keeps every step a
 * process of its own, with its own log file and its own line on the board.
 */
export async function runTarget(phase: Phase, name: string, flags: TargetFlags = {}) {
  const step = phaseOf(loadConfig(), phase).find((entry) => entry.name === name);
  if (!step) throw new Error(`No "devkit.${phase}.${name}" in package.json`);
  if (!step.type) throw new Error(`"devkit.${phase}.${name}" has no "type"`);

  const target = TARGETS[phase][step.type];
  if (!target) {
    const known = Object.keys(TARGETS[phase]).join(", ");
    throw new Error(`Unknown ${phase} type "${step.type}" — known types: ${known}`);
  }
  await target(step.options ?? {}, flags);
}
