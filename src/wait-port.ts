import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const PROBE_TIMEOUT_MS = 2_000;

/** Whether something on this local port answers HTTP without a server error. */
export async function probePort(port: number | string): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.status < 500;
  } catch {
    // not listening yet, or still compiling the first response
    return false;
  }
}

/** Poll a local port until it accepts HTTP connections (or the timeout elapses). */
export async function waitForPort(
  port: number | string,
  { timeoutMs = 60_000, intervalMs = 400 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePort(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/** Open a URL in the default browser (macOS / Linux / Windows). */
export async function openUrl(url: string): Promise<void> {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  await execAsync(`${opener} ${url}`);
}
