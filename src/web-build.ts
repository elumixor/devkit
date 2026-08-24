/**
 * Every native shell carries its own copy of the web app, built with its own API base URL — and
 * `devkit build` runs those builds beside each other. Vite, SvelteKit and the output directory all
 * default to one place per project, so each build is given its own or they overwrite each other's
 * files halfway through.
 */
export function isolatedWebEnv(suffix: string): Record<string, string> {
  return {
    BUILD_DIR: `build-${suffix}`,
    KIT_DIR: `.svelte-kit-${suffix}`,
    VITE_CACHE_DIR: `node_modules/.vite-${suffix}`,
  };
}
