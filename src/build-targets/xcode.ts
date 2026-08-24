import { type XcodeBuild, xcodeBuild } from "../apple.ts";

/**
 * Compiles one Xcode scheme for a simulator — a watch app, a widget, anything native that carries
 * no web bundle of its own and so needs nothing built before it.
 */
export async function buildXcode(options: XcodeBuild) {
  await xcodeBuild(options);
}
