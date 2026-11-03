/**
 * Builds a Nitro app for Lambda with response streaming on.
 *
 * Run as its own process (`bun nitro-build.ts <backend dir>`): the project's own `nitropack` is
 * loaded from that directory, and `awsLambda.streaming` is passed as an override — the CLI's
 * `--preset` flag can set the preset but not that option, and the project's config keeps saying
 * `vercel` until the move is over.
 */
const [, , dir] = process.argv;
if (!dir) throw new Error("usage: bun nitro-build.ts <backend dir>");
process.chdir(dir);

type NitroModule = {
  createNitro: (config: Record<string, unknown>) => Promise<{ close: () => Promise<void> }>;
  prepare: (nitro: unknown) => Promise<void>;
  copyPublicAssets: (nitro: unknown) => Promise<void>;
  build: (nitro: unknown) => Promise<void>;
};

const nitroModule = (await import(resolveNitro(dir))) as NitroModule;
const nitro = await nitroModule.createNitro({
  rootDir: dir,
  dev: false,
  preset: "aws-lambda",
  awsLambda: { streaming: true },
  // devkit ships TypeScript (`@elumixor/devkit/blob`, `/runtime`), and Nitro's esbuild skips node_modules.
  esbuild: { options: { exclude: /node_modules\/(?!\.bun\/@elumixor\+devkit|@elumixor\/devkit)/ } },
});
await nitroModule.prepare(nitro);
await nitroModule.copyPublicAssets(nitro);
await nitroModule.build(nitro);
await nitro.close();

/** `nitropack` today, `nitro` once projects move to v3. */
function resolveNitro(from: string) {
  for (const name of ["nitropack", "nitro"]) {
    try {
      return Bun.resolveSync(name, from);
    } catch {
      // not this one — the next name is tried, and the error below names both
    }
  }
  throw new Error(`Neither "nitropack" nor "nitro" is installed in ${from}`);
}
