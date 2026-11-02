import { fetchLogEvents, parseDuration, Target } from "@elumixor/devkit/cloud";

export default defineEventHandler((event) => {
  const { project, stage, since, grep, limit } = getQuery(event) as Record<string, string | undefined>;
  if (!project || !stage) throw createError({ statusCode: 400, statusMessage: "project and stage are required" });
  return fetchLogEvents(new Target(project, stage), {
    startTime: Date.now() - parseDuration(since ?? "1h"),
    grep: grep || undefined,
    limit: Number(limit ?? 500),
  });
});
