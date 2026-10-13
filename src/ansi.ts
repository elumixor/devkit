/** Terminal colour helpers shared by the build board and the plain dev log. */

export const PALETTE: readonly string[] = ["magenta", "cyan", "yellow", "green", "blue", "red"];

const COLORS: Record<string, string> = {
  black: "30",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
  white: "37",
  gray: "90",
};

export const paint = (text: string, color: string) => `\x1b[${COLORS[color] ?? "37"}m${text}\x1b[0m`;
export const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
export const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;

// Colour codes take no space on screen, so anything that lays text out has to measure what a reader would see.
// biome-ignore lint/suspicious/noControlCharactersInRegex: an escape sequence is the thing being matched
export const SGR = /\x1b\[[0-9;]*m/g;
export const stripColor = (text: string) => text.replace(SGR, "");
export const visibleLength = (text: string) => stripColor(text).length;
