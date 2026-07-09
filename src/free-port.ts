import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** Kill whatever is listening on `port` so a dev server can always bind it. */
export async function freePort(port: number | string): Promise<void> {
  try {
    const { stdout } = await execAsync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    const pids = [
      ...new Set(
        stdout
          .split("\n")
          .slice(1)
          .map((line) => line.trim().split(/\s+/)[1])
          .filter(Boolean),
      ),
    ];
    if (pids.length > 0) {
      await execAsync(`kill -9 ${pids.join(" ")}`);
      console.log(`✓ Freed port ${port} (killed ${pids.join(", ")})`);
    } else {
      console.log(`✓ Port ${port} already free`);
    }
  } catch {
    // lsof exits 1 when nothing is listening
    console.log(`✓ Port ${port} already free`);
  }
}
