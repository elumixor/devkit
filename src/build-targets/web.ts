import { existsSync } from "node:fs";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { RUNTIME_WRAPPER, WRAPPER_FILE } from "../cloud/runtime-wrapper.ts";

/** A client-rendered web app and a Nitro API packed into one deployment. */
export interface WebBuildOptions {
  /** Web app dir, run with `bun run build` (default `apps/frontend`). */
  frontendDir?: string;
  /** Nitro dir (default `apps/backend`). */
  backendDir?: string;
  /** Where the web build lands inside `frontendDir` (default `build`). */
  webBuildDir?: string;
  /** Path prefixes the API owns; everything else answers with the app shell. */
  apiPrefixes: string[];
  /** Extra staged directories to serve, as `{ "<source dir>": "<path under the site>" }`. */
  include?: Record<string, string>;
  /** Who serves the result: Vercel's build output API, or Devkit Cloud's S3 + Lambda (default `vercel`). */
  host?: "vercel" | "aws";
}

/** Where the `aws` host's build lands, relative to the repo root. */
export const AWS_OUTPUT = ".devkit/out";

/**
 * Build a client-rendered web app and a Nitro API into a single deployment: the app as static
 * files, the API as the one serverless function behind them. Both end up at the same origin, so
 * the web client calls the API without CORS and there is one URL to remember.
 */
export async function buildWeb(options: WebBuildOptions) {
  const root = process.cwd();
  const frontend = resolve(root, options.frontendDir ?? "apps/frontend");
  const backend = resolve(root, options.backendDir ?? "apps/backend");
  const webBuild = join(frontend, options.webBuildDir ?? "build");

  await $`bun run build`.cwd(frontend);
  if (!existsSync(webBuild)) throw new Error(`No web build at ${webBuild} — did the web build land?`);

  if (options.host === "aws") return buildForAws(root, backend, webBuild, options);
  return buildForVercel(root, backend, webBuild, options);
}

async function buildForVercel(root: string, backend: string, webBuild: string, options: WebBuildOptions) {
  const webDir = join(backend, "public");
  const nitroOutput = join(backend, ".vercel/output");
  const finalOutput = join(root, ".vercel/output");

  await rm(webDir, { recursive: true, force: true });
  await cp(webBuild, webDir, { recursive: true });
  await copyIncluded(root, webDir, options.include);

  await rm(nitroOutput, { recursive: true, force: true });
  await $`bunx nitro build --preset vercel`.cwd(backend);

  await rm(finalOutput, { recursive: true, force: true });
  await rename(nitroOutput, finalOutput);

  await routeUnmatchedPathsToTheApp(finalOutput, options.apiPrefixes ?? []);
}

/**
 * For Devkit Cloud the edge serves the static files from S3 and the function only answers the API,
 * so the web build never enters the Nitro bundle: `.devkit/out/static` is uploaded, `.devkit/out/server`
 * is zipped, with the runtime wrapper written in as the Lambda entry.
 */
async function buildForAws(root: string, backend: string, webBuild: string, options: WebBuildOptions) {
  const output = join(root, AWS_OUTPUT);
  const staticDir = join(output, "static");
  const serverDir = join(output, "server");
  const nitroOutput = join(backend, ".output");

  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(webBuild, staticDir, { recursive: true });
  await copyIncluded(root, staticDir, options.include);

  await rm(nitroOutput, { recursive: true, force: true });
  await $`bun ${join(import.meta.dir, "../cloud/nitro-build.ts")} ${backend}`;
  await rename(join(nitroOutput, "server"), serverDir);
  // Nitro's own public assets (an openapi page, say) are served by the edge as well.
  if (existsSync(join(nitroOutput, "public"))) await cp(join(nitroOutput, "public"), staticDir, { recursive: true });

  await Bun.write(join(serverDir, WRAPPER_FILE), RUNTIME_WRAPPER);
  console.log(`Static files in ${AWS_OUTPUT}/static, function in ${AWS_OUTPUT}/server`);
}

/**
 * Anything a sibling platform staged for the site to hand out — an installer, say — rides along
 * with the web files rather than living in the frontend's static folder, which other builds copy
 * wholesale.
 */
async function copyIncluded(root: string, webDir: string, include: Record<string, string> = {}) {
  for (const [from, to] of Object.entries(include)) {
    const staged = resolve(root, from);
    if (!existsSync(staged)) {
      console.log(`Nothing staged at ${from} — the site will serve no ${to}`);
      continue;
    }
    await cp(staged, join(webDir, to), { recursive: true });
    console.log(`Serving ${from} at /${to}`);
  }
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
