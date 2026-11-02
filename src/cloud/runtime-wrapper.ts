import { EDGE_HEADER, HOST_HEADER } from "./names.ts";

/** Where `@elumixor/devkit/runtime` finds the wrapper's `waitUntil` at run time. */
export const WAIT_UNTIL_SYMBOL = "dk.waitUntil";
export const WRAPPER_FILE = "dk-handler.mjs";

/**
 * The file written next to Nitro's `index.mjs` in every deploy. It is the Lambda handler: it keeps
 * direct callers out, turns a schedule's event into the HTTP call it stands for, restores the
 * viewer's hostname, and holds the invocation open for `waitUntil` work after the response ends.
 *
 * Plain JavaScript with no imports beyond Node, so it needs nothing installed in the bundle.
 */
export const RUNTIME_WRAPPER = `import { AsyncLocalStorage } from "node:async_hooks";
import { handler as nitro } from "./index.mjs";

const EDGE_SECRET = process.env.DK_EDGE_SECRET;
const CRON_SECRET = process.env.CRON_SECRET;
const EDGE_HEADER = ${JSON.stringify(EDGE_HEADER)};
const HOST_HEADER = ${JSON.stringify(HOST_HEADER)};
const pendingWork = new AsyncLocalStorage();

globalThis[Symbol.for(${JSON.stringify(WAIT_UNTIL_SYMBOL)})] = (promise) => {
  const pending = pendingWork.getStore();
  if (pending) pending.push(Promise.resolve(promise));
  else console.warn("waitUntil called outside a request; the promise is not awaited");
};

export const handler = awslambda.streamifyResponse(async (rawEvent, responseStream, context) => {
  const event = rawEvent.dk === "cron" ? cronRequest(rawEvent) : rawEvent;
  if (!EDGE_SECRET || event.headers?.[EDGE_HEADER] !== EDGE_SECRET) return reject(responseStream, 403, "Forbidden");

  const viewerHost = event.headers[HOST_HEADER];
  if (viewerHost) {
    event.headers.host = viewerHost;
    event.headers["x-forwarded-host"] = viewerHost;
    if (event.requestContext) event.requestContext.domainName = viewerHost;
  }
  delete event.headers[EDGE_HEADER];
  delete event.headers[HOST_HEADER];

  const pending = [];
  await pendingWork.run(pending, () => nitro(event, responseStream, context));
  if (pending.length) {
    const results = await Promise.allSettled(pending);
    for (const result of results) if (result.status === "rejected") console.error("waitUntil task failed", result.reason);
  }
});

// A schedule delivers {"dk":"cron","path":"/api/cron/x"}; the app sees the same GET Vercel would send.
function cronRequest(event) {
  const path = event.path;
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: {
      host: process.env.DK_HOST ?? "localhost",
      accept: "*/*",
      "user-agent": "devkit-cloud-cron",
      ...(CRON_SECRET ? { authorization: "Bearer " + CRON_SECRET } : {}),
      [EDGE_HEADER]: EDGE_SECRET,
    },
    requestContext: {
      domainName: process.env.DK_HOST ?? "localhost",
      http: { method: "GET", path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "devkit-cloud-cron" },
      requestId: event.requestId ?? "cron",
      time: new Date().toUTCString(),
      timeEpoch: Date.now(),
    },
    isBase64Encoded: false,
  };
}

function reject(responseStream, statusCode, message) {
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode,
    headers: { "content-type": "text/plain" },
  });
  stream.write(message);
  stream.end();
}
`;
