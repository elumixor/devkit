import { spawnSync } from "node:child_process";

/** Native copy commands, tried in order; OSC 52 covers the rest, ssh sessions included. */
const COMMANDS: readonly (readonly [string, ...string[]])[] =
  process.platform === "darwin"
    ? [["pbcopy"]]
    : process.platform === "win32"
      ? [["clip"]]
      : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];

export function copyToClipboard(text: string, stdout: NodeJS.WriteStream) {
  for (const [command, ...args] of COMMANDS) {
    const result = spawnSync(command, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
    if (!result.error && result.status === 0) return;
  }
  stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
}
