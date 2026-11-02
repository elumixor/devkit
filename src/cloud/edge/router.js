// The Devkit Cloud router: one CloudFront Function (JavaScript runtime 2.0) on the viewer-request
// event of the shared distribution. It reads the hostname's route record from the KeyValueStore
// and sends the request to that project's function, its deploy's static files, or its public blobs.
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
var NO_SITE = {
  statusCode: 404,
  statusDescription: "Not Found",
  headers: { "content-type": { value: "text/plain" } },
  body: "No site is deployed at this hostname.",
};

async function handler(event) {
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value.toLowerCase() : "";

  var route;
  try {
    route = JSON.parse(await routes.get(host));
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
