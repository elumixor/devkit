import type { Readable } from "node:stream";

// Cursor moves, screen clears and window titles would tear the board apart; colours are kept.
const CONTROL =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the thing being matched
  /\x1b\[[0-9;?]*[A-Za-ln-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>()][0-9A-Za-z]?|[\x00-\x08\x0b-\x1a\x7f]/g;
const TAB = "  ";

/** One printed line as a reader saw it: a `\r` redraw keeps only what was drawn last. */
export function cleanLine(raw: string): string {
  const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  return line
    .slice(line.lastIndexOf("\r") + 1)
    .replace(CONTROL, "")
    .replaceAll("\t", TAB);
}

/** Calls `onLine` for every complete line the stream prints, and for the unterminated rest at its end. */
export function eachLine(stream: Readable, onLine: (line: string) => void) {
  let rest = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    const parts = (rest + chunk).split("\n");
    rest = parts.pop() ?? "";
    for (const part of parts) onLine(part);
  });
  stream.on("end", () => {
    if (rest) onLine(rest);
  });
}
