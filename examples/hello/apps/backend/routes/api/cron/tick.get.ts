import { put } from "@elumixor/devkit/blob";

// Called every five minutes by the platform, exactly as Vercel would call it: a GET with the cron secret.
export default defineEventHandler(async (event) => {
  const expected = process.env.CRON_SECRET;
  if (expected && getHeader(event, "authorization") !== `Bearer ${expected}`)
    throw createError({ statusCode: 401, statusMessage: "Not the cron" });
  const now = new Date().toISOString();
  await put("cron/last.txt", now, { contentType: "text/plain" });
  return { ticked: now };
});
