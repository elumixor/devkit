import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import { targetByName } from "./commands/context.ts";
import { addDomain, listDomains, removeDomain } from "./commands/domains.ts";
import { rollback } from "./commands/rollback.ts";
import { readStageEnv } from "./env.ts";
import { fetchLogEvents, parseDuration } from "./log-events.ts";
import { age, overview } from "./overview.ts";
import { listDeploys } from "./records.ts";

/**
 * `devkit mcp`: Devkit Cloud over the Model Context Protocol, so an agent can ask what is live,
 * read a stage's logs and roll a deploy back without a terminal. Stdio transport; the AWS
 * credentials are whatever the environment provides, as for the CLI.
 */
export async function runMcp() {
  // Stdout carries the protocol; the shared commands' progress lines go to stderr instead.
  console.log = console.error;
  const server = new McpServer({ name: "devkit-cloud", version: pkg.version });
  const text = (value: unknown) => ({
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  });
  const project = z.string().describe("Project name, e.g. `hello`");
  const stage = z.string().optional().describe("Stage name (default `production`)");

  server.registerTool(
    "cloud_status",
    {
      title: "Devkit Cloud status",
      description:
        "Every deployed project and stage: live deploy, hostnames, and the last 24 h of calls, errors and p95 latency.",
      inputSchema: { project: project.optional() },
    },
    async ({ project }) =>
      text(
        (await overview(project)).map((entry) => ({
          project: entry.project,
          stages: entry.stages.map((s) => ({
            stage: s.stage,
            url: `https://${s.hostnames[0]}`,
            hostnames: s.hostnames,
            deployId: s.current?.deployId,
            liveSince: s.current ? age(s.current.since) : undefined,
            commit: s.live?.commit.slice(0, 7),
            message: s.live?.message,
            last24h: s.metrics,
          })),
        })),
      ),
  );

  server.registerTool(
    "cloud_deploys",
    {
      title: "Deploy history",
      description: "The last deploys of one stage, newest first, with status, commit, author and any error.",
      inputSchema: { project, stage, limit: z.number().int().min(1).max(50).optional() },
    },
    async ({ project, stage, limit }) => {
      const { target } = await targetByName(project, stage);
      return text(await listDeploys(target, limit ?? 10));
    },
  );

  server.registerTool(
    "cloud_logs",
    {
      title: "Function logs",
      description: "CloudWatch log lines of a stage's function, oldest first.",
      inputSchema: {
        project,
        stage,
        since: z.string().optional().describe("How far back: 30m, 2h, 1d (default 1h)"),
        grep: z.string().optional().describe("CloudWatch filter pattern: a word, a quoted phrase, or ?a ?b"),
        limit: z.number().int().min(1).max(2000).optional().describe("Most lines to return (default 500)"),
      },
    },
    async ({ project, stage, since, grep, limit }) => {
      const { target } = await targetByName(project, stage);
      const events = await fetchLogEvents(target, {
        startTime: Date.now() - parseDuration(since ?? "1h"),
        grep,
        limit: limit ?? 500,
      });
      return text(
        events.map((event) => `${new Date(event.timestamp).toISOString()} ${event.message}`).join("\n") ||
          "(no log lines)",
      );
    },
  );

  server.registerTool(
    "cloud_rollback",
    {
      title: "Roll back",
      description:
        "Point a stage back at an earlier deploy (the previous one unless `to` names a deploy id). Takes a few seconds.",
      inputSchema: { project, stage, to: z.string().optional().describe("Deploy id to go back to") },
    },
    async ({ project, stage, to }) => text(await rollback(project, stage, to)),
  );

  server.registerTool(
    "cloud_env",
    {
      title: "Stage env keys",
      description: "The variable names set on a stage (values are never returned).",
      inputSchema: { project, stage },
    },
    async ({ project, stage }) => {
      const { target } = await targetByName(project, stage);
      return text(Object.keys(await readStageEnv(target)).sort());
    },
  );

  server.registerTool(
    "cloud_domains",
    {
      title: "Hostnames",
      description: "Every hostname each stage of a project answers on, the primary one first.",
      inputSchema: { project },
    },
    async ({ project }) => text(await listDomains(project)),
  );

  server.registerTool(
    "cloud_domain_add",
    {
      title: "Add hostname",
      description:
        "Point a hostname at a stage: certificate, CloudFront alias, Cloudflare DNS record and route. Kept by later deploys. A new hostname may need a minute or two (longer when a certificate is issued).",
      inputSchema: { project, host: z.string().describe("Hostname, e.g. app.example.com"), stage },
    },
    async ({ project, host, stage }) => text(await addDomain(project, host, stage)),
  );

  server.registerTool(
    "cloud_domain_remove",
    {
      title: "Remove hostname",
      description: "Take a hostname off a stage: route, alias and DNS record. The default hostname stays.",
      inputSchema: { project, host: z.string(), stage },
    },
    async ({ project, host, stage }) => text(await removeDomain(project, host, stage)),
  );

  await server.connect(new StdioServerTransport());
}
