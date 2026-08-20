import { $ } from "bun";

/**
 * Tag the current commit and push the tag, which is how a CI release is asked for: `ios` becomes
 * `ios-v20260820203000`. The timestamp is what keeps two releases of the same commit apart.
 */
export async function runRelease(prefix: string) {
  if (!prefix) throw new Error("usage: devkit release <prefix>");

  const now = new Date();
  const stamp = [
    now.getFullYear(),
    now.getMonth() + 1,
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
  ]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("");

  const tag = `${prefix}-v${stamp}`;
  await $`git tag ${tag}`;
  await $`git push origin ${tag}`;
  console.log(`Pushed ${tag}`);
}
