import { listDeploys, Target } from "@elumixor/devkit/cloud";

export default defineEventHandler((event) => {
  const { project, stage, limit } = getQuery(event) as Record<string, string | undefined>;
  if (!project || !stage) throw createError({ statusCode: 400, statusMessage: "project and stage are required" });
  return listDeploys(new Target(project, stage), Number(limit ?? 20));
});
