import { expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const store: Record<string, string> = {};
mock.module("cloudfront", () => ({
  default: {
    kvs: () => ({
      get: (key: string) => (key in store ? Promise.resolve(store[key]) : Promise.reject(new Error("missing"))),
    }),
  },
}));

const source = await Bun.file(new URL("./router.js", import.meta.url)).text();
// The router is a CloudFront Function script, not a module: export its handler from a copy.
const copy = join(mkdtempSync(join(tmpdir(), "dk-router-")), "router.js");
await Bun.write(copy, `${source}\nexport { handler };`);
const { handler } = await import(copy);

function viewerResponse(headers: Record<string, { value: string }>) {
  return {
    context: { eventType: "viewer-response" },
    request: { uri: "/mcp", headers: { host: { value: "api.example.com" } } },
    response: { statusCode: 401, headers },
  };
}

test("restores WWW-Authenticate remapped by the Lambda Function URL", async () => {
  store["api.example.com"] = JSON.stringify({ p: "app", d: "d1", fn: "x.lambda-url.aws" });
  const value = 'Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp"';
  const response = await handler(viewerResponse({ "x-amzn-remapped-www-authenticate": { value } }));
  expect(response.headers["www-authenticate"]).toEqual({ value });
  expect(response.headers["x-amzn-remapped-www-authenticate"]).toBeUndefined();
});

test("restores the header even when the host has no route", async () => {
  delete store["api.example.com"];
  const response = await handler(viewerResponse({ "x-amzn-remapped-www-authenticate": { value: "Bearer" } }));
  expect(response.headers["www-authenticate"]).toEqual({ value: "Bearer" });
});
