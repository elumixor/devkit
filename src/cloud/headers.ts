import { CloudError } from "./aws.ts";

/**
 * Response headers for the paths matching `source`, as in `vercel.json`: `headers` is a map of
 * name to value, or Vercel's `[{ key, value }]` list so a `vercel.json` block can be pasted as is.
 */
export interface HeaderRule {
  /** `/bar.js`, `/icons/(.*)`, `/:path*` — `:name` is one segment, `:name*` any depth, `( )` a raw regex. */
  source: string;
  headers: Record<string, string> | { key: string; value: string }[];
}

/** A KVS value may be 1 KB at most, and the compiled rules are one value. */
const MAX_BYTES = 1024;

/**
 * Compiles the rules into what the edge reads on every response: `[[regex, { name: value }], ...]`
 * with lowercase names, or nothing when there are no rules.
 */
export function compileHeaders(rules: readonly HeaderRule[] = []): string | undefined {
  if (!rules.length) return undefined;
  const compiled = rules.map((rule) => {
    const pairs = Array.isArray(rule.headers)
      ? rule.headers.map(({ key, value }) => [key, value] as const)
      : Object.entries(rule.headers);
    const headers = Object.fromEntries(pairs.map(([name, value]) => [name.toLowerCase(), String(value)]));
    return [sourceToRegex(rule.source), headers];
  });
  const value = JSON.stringify(compiled);
  if (new TextEncoder().encode(value).byteLength > MAX_BYTES)
    throw new CloudError(`"headers" compile to more than ${MAX_BYTES} bytes — merge rules or shorten values`);
  return value;
}

/** Vercel's path syntax as an anchored regex source. */
export function sourceToRegex(source: string) {
  if (!source.startsWith("/")) throw new CloudError(`Header source "${source}" must start with "/"`);
  let out = "";
  for (let i = 0; i < source.length; ) {
    const char = source[i] as string;
    if (char === "(") {
      let depth = 0;
      let j = i;
      for (; j < source.length; j++) {
        if (source[j] === "(") depth++;
        else if (source[j] === ")" && --depth === 0) break;
      }
      if (depth) throw new CloudError(`Header source "${source}" has an unclosed "("`);
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const param = char === ":" ? /^:[A-Za-z_][A-Za-z0-9_]*([*+?])?/.exec(source.slice(i)) : null;
    if (param) {
      const modifier = param[1];
      out += modifier === "*" ? ".*" : modifier === "+" ? ".+" : modifier === "?" ? "[^/]*" : "[^/]+";
      i += param[0].length;
      continue;
    }
    out += /[.*+?^${}|[\]\\]/.test(char) ? `\\${char}` : char;
    i++;
  }
  return `^${out}$`;
}
