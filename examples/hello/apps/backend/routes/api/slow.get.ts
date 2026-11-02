import { put } from "@elumixor/devkit/blob";
import { waitUntil } from "@elumixor/devkit/runtime";

// Answers at once; the blob is written three seconds after the response has gone out.
export default defineEventHandler(() => {
  const startedAt = new Date().toISOString();
  waitUntil(
    sleep(3000).then(() =>
      put("slow/last.txt", `response sent ${startedAt}, blob written ${new Date().toISOString()}`, {
        contentType: "text/plain",
      }),
    ),
  );
  return { startedAt, note: "check /_blob/slow/last.txt in a few seconds" };
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
