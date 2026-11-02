/**
 * `@elumixor/devkit/cloud`: what an app running on the platform may read about the platform —
 * the dashboard is one. Everything here is read-only; deploys and rollbacks stay with the CLI.
 */
export { fetchLogEvents, type LogEvent, parseDuration } from "./log-events.ts";
export { BASE_DOMAIN } from "./names.ts";
export { age, type Metrics, overview, type ProjectOverview, type StageOverview } from "./overview.ts";
export { Target } from "./project.ts";
export { type DeployRecord, listDeploys, readRegistry } from "./records.ts";
