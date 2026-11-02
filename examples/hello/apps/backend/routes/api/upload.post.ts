import { put } from "@elumixor/devkit/blob";

export default defineEventHandler(async (event) => {
  const body = await readRawBody(event, false);
  if (!body) throw createError({ statusCode: 400, statusMessage: "No body" });
  const stored = await put(`uploads/${Date.now()}.bin`, body, { contentType: "application/octet-stream" });
  return { bytes: body.byteLength, url: stored.url };
});
