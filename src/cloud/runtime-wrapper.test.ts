import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_WRAPPER, WRAPPER_FILE } from "./runtime-wrapper.ts";

type Prelude = { statusCode?: number; headers?: Record<string, string> };

// The wrapper imports Nitro's handler from ./index.mjs: a stand-in answers with the prelude a test sets.
const dir = mkdtempSync(join(tmpdir(), "dk-wrapper-"));
await Bun.write(
  join(dir, "index.mjs"),
  "export const handler = (event, stream) => awslambda.HttpResponseStream.from(stream, globalThis.nitroPrelude);",
);
await Bun.write(join(dir, WRAPPER_FILE), RUNTIME_WRAPPER);
process.env.DK_EDGE_SECRET = "secret";
Object.assign(globalThis, {
  awslambda: {
    streamifyResponse: (fn: unknown) => fn,
    HttpResponseStream: { from: (stream: { prelude?: Prelude }, prelude: Prelude) => Object.assign(stream, { prelude }) },
  },
});
const { handler } = await import(join(dir, WRAPPER_FILE));

async function respond(prelude: Prelude) {
  Object.assign(globalThis, { nitroPrelude: prelude });
  const stream: { prelude?: Prelude } = {};
  await handler({ headers: { "x-dk-edge": "secret" } }, stream, {});
  return stream.prelude;
}

test("sends a 401 with WWW-Authenticate as 200 carrying the real status", async () => {
  const prelude = await respond({ statusCode: 401, headers: { "WWW-Authenticate": "Bearer" } });
  expect(prelude).toEqual({ statusCode: 200, headers: { "WWW-Authenticate": "Bearer", "x-dk-status": "401" } });
});

test("leaves other responses alone", async () => {
  const plain = { statusCode: 404, headers: { "content-type": "text/plain" } };
  expect(await respond(plain)).toEqual(plain);
  const ok = { statusCode: 200, headers: { "www-authenticate": "Bearer" } };
  expect(await respond(ok)).toEqual(ok);
});
