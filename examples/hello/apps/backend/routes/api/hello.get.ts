import { deployment } from "@elumixor/devkit/runtime";

export default defineEventHandler((event) => ({
  message: process.env.HELLO_MESSAGE ?? "HELLO_MESSAGE is not set",
  host: getRequestHost(event, { xForwardedHost: true }),
  deploy: deployment.id ?? null,
  stage: deployment.stage ?? null,
}));
