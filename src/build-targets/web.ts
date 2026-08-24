import { existsSync } from "node:fs";
import { cp, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $ } from "bun";

/** A client-rendered web app and a Nitro API packed into one Vercel deployment. */
export interface WebBuildOptions {
  /** Web app dir, run with `bun run build` (default `apps/frontend`). */
  frontendDir?: string;
  /** Nitro dir, built with `bunx nitro build --preset vercel` (default `apps/backend`). */
  backendDir?: string;
  /** Where the web build lands inside `frontendDir` (default `build`). */
  webBuildDir?: string;
  /** Path prefixes the API owns; everything else answers with the app shell. */
  apiPrefixes: string[];
  /** Extra staged directories to serve, as `{ "<source dir>": "<path under the site>" }`. */
  include?: Record<string, string>;
}

/**
 * Build a client-rendered web app and a Nitro API into a single Vercel deployment: the app as
 * static files, the API as the one serverless function behind them. Both end up at the same
 * origin, so the web client calls the API without CORS and there is one URL to remember.
 */
export async function buildWeb(options: WebBuildOptions) {
  const root = process.cwd();
  const frontend = resolve(root, options.frontendDir ?? "apps/frontend");
  const backend = resolve(root, options.backendDir ?? "apps/backend");
  const webDir = join(backend, "public");
  const nitroOutput = join(backend, ".vercel/output");
  const finalOutput = join(root, ".vercel/output");

  await $`bun run build`.cwd(frontend);
  await rm(webDir, { recursive: true, force: true });
  await cp(join(frontend, options.webBuildDir ?? "build"), webDir, { recursive: true });

  // Anything a sibling platform staged for the site to hand out — an installer, say — rides along
  // with the web files rather than living in the frontend's static folder, which other builds
  // copy wholesale.
  for (const [from, to] of Object.entries(options.include ?? {})) {
    const staged = resolve(root, from);
    if (!existsSync(staged)) {
      console.log(`Nothing staged at ${from} — the site will serve no ${to}`);
      continue;
    }
    await cp(staged, join(webDir, to), { recursive: true });
    console.log(`Serving ${from} at /${to}`);
  }

  await rm(nitroOutput, { recursive: true, force: true });
  await $`bunx nitro build --preset vercel`.cwd(backend);

  await rm(finalOutput, { recursive: true, force: true });
  await rename(nitroOutput, finalOutput);

  await routeUnmatchedPathsToTheApp(finalOutput, options.apiPrefixes ?? []);
}

/**
 * The app is one client-rendered bundle, so every path it owns has to answer with `index.html`
 * and let the router sort it out. Nitro ends its routes with a catch-all into the function, which
 * would otherwise answer an unknown web path with an API-shaped 404 JSON body.
 */
async function routeUnmatchedPathsToTheApp(output: string, apiPrefixes: readonly string[]) {
  if (!apiPrefixes.length) throw new Error('"apiPrefixes" must list the paths the API owns');

  const configPath = join(output, "config.json");
  const config = await Bun.file(configPath).json();
  const staticDir = join(output, "static");
  if (!existsSync(staticDir)) throw new Error(`No static output at ${staticDir} — did the web build land?`);

  const catchAll = config.routes.findIndex((route: { dest?: string }) => route.dest === "/__fallback");
  config.routes.splice(catchAll < 0 ? config.routes.length : catchAll, 0, {
    src: `/((?!${apiPrefixes.join("|")}).*)`,
    dest: "/index.html",
  });

  await Bun.write(configPath, JSON.stringify(config, null, 2));
  console.log("Unmatched web paths route to the app shell");
}
