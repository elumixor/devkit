import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** Poll a local port until it accepts HTTP connections (or the timeout elapses). */
export async function waitForPort(
  port: number | string,
  { timeoutMs = 60_000, intervalMs = 400 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const url = `http://localhost:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/** Open a URL in the default browser (macOS / Linux / Windows). */
export async function openUrl(url: string): Promise<void> {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  await execAsync(`${opener} ${url}`);
}
