import { list } from "@elumixor/devkit/blob";

export default defineEventHandler(async () => {
  const { blobs } = await list();
  return blobs.map((blob) => ({ pathname: blob.pathname, size: blob.size, uploadedAt: blob.uploadedAt, url: blob.url }));
});
