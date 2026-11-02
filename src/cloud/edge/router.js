// The Devkit Cloud router: one CloudFront Function (JavaScript runtime 2.0) on the viewer-request
// and viewer-response events of the shared distribution. On a request it reads the hostname's route
// record from the KeyValueStore and sends the request to that project's function, its deploy's
// static files, or its public blobs. On a response it adds the deploy's configured headers, if any.
//
// Deployed by `devkit cloud bootstrap`; the header and key names are the ones in src/cloud/names.ts.
import cf from "cloudfront";

var routes = cf.kvs();

var EDGE_SECRET_KEY = "_edge";
var EDGE_HEADER = "x-dk-edge";
var HOST_HEADER = "x-dk-host";
var PROJECT_HEADER = "x-dk-project";
var BLOB_PREFIX = "/_blob/";
var SSR_ASSETS_PREFIX = "/_app/";
var HEADERS_PREFIX = "_h/";
var NO_SITE = {
  statusCode: 404,
  statusDescription: "Not Found",
  headers: { "content-type": { value: "text/plain" } },
  body: "No site is deployed at this hostname.",
};

async function handler(event) {
  if (event.context.eventType === "viewer-response") return withHeaders(event);
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value.toLowerCase() : "";

  // The runtime allows `await` only as a whole statement, never inside another expression.
  var route;
  try {
    var record = await routes.get(host);
    route = JSON.parse(record);
  } catch (e) {
    return NO_SITE;
  }

  var uri = request.uri;
  // A viewer may not forge the headers the function trusts.
  delete request.headers[EDGE_HEADER];
  delete request.headers[HOST_HEADER];
  request.headers[PROJECT_HEADER] = { value: route.p };

  if (isApi(uri, route)) {
    var secret = await routes.get(EDGE_SECRET_KEY);
    var customHeaders = {};
    customHeaders[EDGE_HEADER] = secret;
    customHeaders[HOST_HEADER] = host;
    cf.updateRequestOrigin({
      domainName: route.fn,
      originAccessControlConfig: { enabled: false },
      customOriginConfig: { port: 443, protocol: "https", sslProtocols: ["TLSv1.2"] },
      customHeaders: customHeaders,
      originPath: "",
      timeouts: { readTimeout: 60, keepAliveTimeout: 60, connectionTimeout: 10 },
    });
    return request;
  }

  if (uri.indexOf(BLOB_PREFIX) === 0) {
    cf.selectRequestOriginById("blobs");
    request.uri = "/" + route.p + "/" + route.s + "/public/" + uri.slice(BLOB_PREFIX.length);
    return request;
  }

  request.uri = "/" + route.p + "/" + route.d + staticPath(uri, route.mode);
  return request;
}

function isApi(uri, route) {
  if (route.mode === "ssr") return uri.indexOf(SSR_ASSETS_PREFIX) !== 0 && uri.indexOf(BLOB_PREFIX) !== 0;
  var prefixes = route.api || [];
  for (var i = 0; i < prefixes.length; i++) {
    var prefix = "/" + prefixes[i];
    if (uri === prefix || uri.indexOf(prefix + "/") === 0) return true;
  }
  return false;
}

// `spa`: any path that doesn't name a file is the app shell. `pages`: a path without a file is a
// folder holding an index.html. A trailing slash means the folder's index either way.
function staticPath(uri, mode) {
  if (uri === "" || uri === "/") return "/index.html";
  var last = uri.slice(uri.lastIndexOf("/") + 1);
  if (last.indexOf(".") !== -1) return uri;
  if (mode === "pages") return (uri.slice(-1) === "/" ? uri : uri + "/") + "index.html";
  return "/index.html";
}

// Rules match the path the viewer asked for. The request here may carry the rewritten static path
// (`/<project>/<deploy>/...`), so that prefix comes off first.
async function withHeaders(event) {
  var response = event.response;
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value.toLowerCase() : "";
  try {
    var record = await routes.get(host);
    var route = JSON.parse(record);
    if (!route.h) return response;
    var raw = await routes.get(HEADERS_PREFIX + route.p + "/" + route.d);
    var rules = JSON.parse(raw);
    var uri = request.uri;
    var rewritten = "/" + route.p + "/" + route.d + "/";
    if (uri.indexOf(rewritten) === 0) uri = uri.slice(rewritten.length - 1);
    for (var i = 0; i < rules.length; i++) {
      if (!new RegExp(rules[i][0]).test(uri)) continue;
      var names = Object.keys(rules[i][1]);
      for (var j = 0; j < names.length; j++) response.headers[names[j]] = { value: rules[i][1][names[j]] };
    }
  } catch (e) {
    // No route or no headers: the response goes out as the origin made it.
  }
  return response;
}
