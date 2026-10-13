import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** Kill whatever is listening on `port` so a dev server can always bind it. Returns the killed pids. */
export async function freePort(port: number | string): Promise<string[]> {
  const listening = await execAsync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`).then(
    ({ stdout }) => stdout,
    // lsof exits 1 when nothing is listening
    () => "",
  );
  const pids = [
    ...new Set(
      listening
        .split("\n")
        .slice(1)
        .map((line) => line.trim().split(/\s+/)[1])
        .filter((pid): pid is string => Boolean(pid)),
    ),
  ];
  if (pids.length > 0) await execAsync(`kill -9 ${pids.join(" ")}`);
  return pids;
}
