import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

export interface TauriMacosTargetOptions {
  /** Tauri project dir, holding `src-tauri` (default `apps/frontend`). */
  frontendDir?: string;
  /** Where the DMG and its manifest are staged for a web deploy to serve (default `dist/download`). */
  stageDir?: string;
  /** Reinstall to `/Applications/<name>.app` after building, if it's already there (default true). */
  installIfPresent?: boolean;
  /** Open the reinstalled app once it's in place, so the deploy ends on the new build running (default true). */
  relaunch?: boolean;
  /** App Store Connect key env vars, for notarization (defaults match the iOS release). */
  keyIdEnv?: string;
  issuerIdEnv?: string;
  keyPathEnv?: string;
}

/**
 * Builds the macOS app, signs and notarizes it if this machine has a Developer ID certificate,
 * and stages the DMG (plus a manifest describing it) for the web deploy to hand out. Refreshes
 * the local install too, if this machine already has one.
 */
export async function deployTauriMacos(options: TauriMacosTargetOptions = {}) {
  const frontendDir = options.frontendDir ?? "apps/frontend";
  const stageDir = options.stageDir ?? "dist/download";
  const bundleDir = join(frontendDir, "src-tauri/target/release/bundle/dmg");
  const appDir = join(frontendDir, "src-tauri/target/release/bundle/macos");

  const conf = (await Bun.file(join(frontendDir, "src-tauri/tauri.conf.json")).json()) as {
    version: string;
    productName: string;
  };
  const { version, productName } = conf;
  const installed = join("/Applications", `${productName}.app`);

  // macOS refuses a downloaded app that carries no signature at all — "App is damaged and can't
  // be opened" — so the bundle is always signed with something. A Developer ID certificate in the
  // keychain also buys notarization, which is the only thing that makes the app open on a click;
  // an ad-hoc signature just moves the refusal to a dialog the user can override in Settings.
  const identity = await developerId();
  if (identity) console.log(`Signing as ${identity}, and notarizing`);
  else console.log("No Developer ID certificate — signing ad-hoc, so the app needs Open Anyway once");

  const keyIdEnv = options.keyIdEnv ?? "APP_STORE_CONNECT_API_KEY_ID";
  const issuerIdEnv = options.issuerIdEnv ?? "APP_STORE_CONNECT_API_KEY_ISSUER_ID";
  const keyPathEnvName = options.keyPathEnv ?? "APP_STORE_CONNECT_API_KEY_PATH";

  // Bundling a DMG consumes the .app it packages, deleting it once the DMG exists — so the .app
  // has to be requested as its own bundle target too, or there's nothing left to reinstall from.
  const reinstall = (options.installIfPresent ?? true) && existsSync(installed);
  await $`bunx tauri build --bundles ${reinstall ? "dmg,app" : "dmg"}`.cwd(frontendDir).env({
    ...process.env,
    APPLE_SIGNING_IDENTITY: identity ?? "-",
    ...(identity
      ? {
          APPLE_API_KEY: required(keyIdEnv),
          APPLE_API_ISSUER: required(issuerIdEnv),
          APPLE_API_KEY_PATH: keyPath(keyIdEnv, keyPathEnvName),
        }
      : {}),
  });

  const dmg = (await readdir(bundleDir)).find((name) => name.endsWith(".dmg"));
  if (!dmg) throw new Error(`No .dmg in ${bundleDir}`);

  // Tauri notarizes and staples the app, then signs the DMG around it — leaving the DMG itself
  // unnotarized, which is what Gatekeeper judges when someone opens the file they downloaded.
  if (identity) await notarize(join(bundleDir, dmg), keyIdEnv, issuerIdEnv, keyPathEnvName);

  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });
  const stagedDmg = join(stageDir, `${productName}.dmg`);
  await $`cp ${join(bundleDir, dmg)} ${stagedDmg}`;

  // What a settings panel prints next to the download button. The app can't read the file's own
  // size or age once it's behind a CDN, and a button that says nothing about what it is asking you
  // to install is a worse button.
  const { size } = await stat(stagedDmg);
  await Bun.write(
    join(stageDir, "desktop.json"),
    `${JSON.stringify(
      { version, bytes: size, builtAt: new Date().toISOString(), arch: "Apple Silicon", notarized: Boolean(identity) },
      null,
      2,
    )}\n`,
  );
  console.log(`Staged ${dmg} (${(size / 1e6).toFixed(1)} MB) for the web deployment`);

  // "Configured" means this machine already has the app installed — a fresh checkout building for
  // the web deploy shouldn't plant a copy nobody asked for.
  if (reinstall) {
    const appBundle = join(appDir, `${productName}.app`);
    if (!existsSync(appBundle)) throw new Error(`Requested "app" alongside "dmg" but there's no bundle at ${appBundle}`);
    await $`osascript -e ${`quit app "${productName}"`}`.nothrow().quiet();
    await $`rm -rf ${installed}`;
    await $`cp -R ${appBundle} ${installed}`;
    await $`xattr -cr ${installed}`.nothrow().quiet();
    console.log(`Reinstalled ${installed}`);
    // The old copy was quit to make room; leaving the new one closed reads as "nothing happened",
    // and the DMG gets dragged into /Applications by hand over a build that is already there.
    if (options.relaunch ?? true) {
      await $`open ${installed}`.nothrow();
      console.log(`Opened ${installed}`);
    }
  }

  /** Sends the disk image to Apple and staples their answer into it, so it opens offline too. */
  async function notarize(path: string, keyIdEnv: string, issuerIdEnv: string, keyPathEnvName: string) {
    const key = ["--key", keyPath(keyIdEnv, keyPathEnvName), "--key-id", required(keyIdEnv), "--issuer", required(issuerIdEnv)];
    await $`xcrun notarytool submit ${path} ${key} --wait`;
    await $`xcrun stapler staple ${path}`;
  }
}

/** The Developer ID identity in this machine's keychain, if the account has one yet. */
async function developerId() {
  const found = await $`security find-identity -v -p codesigning`.quiet().nothrow();
  const line = found.stdout
    .toString()
    .split("\n")
    .find((row) => row.includes("Developer ID Application"));
  return line?.match(/"([^"]+)"/)?.[1];
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing — put it in the repo's .env`);
  return value;
}

/** Notarization takes the same App Store Connect key an iOS release uses. */
function keyPath(keyIdEnv: string, keyPathEnvName: string) {
  return process.env[keyPathEnvName] ?? join(homedir(), ".appstoreconnect/private_keys", `AuthKey_${required(keyIdEnv)}.p8`);
}
