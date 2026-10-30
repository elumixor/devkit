import { stripColor } from "../ansi.ts";
import type { LogEntry } from "./supervisor.ts";

const FRAME = /^\s+at\s/;
const MORE = /^\s+\.\.\. \d+ (?:lines|more)/;
/** A line that reports a failure on its own, without a stack: `error: …`, `TypeError: …`. */
const FAILURE = /^\s*(?:\[[^\]]*\]\s*)?(?:error|\w*Error|\w*Exception)\b:?\s/i;
const DETAIL = /^\s*detail:\s*(['"`])(.*)\1,?$/;

/** A thrown error a service printed: its first line, its stack, and the properties Node dumps after it. */
export interface ErrorBlock {
  /** `seq` of the error's first line. */
  readonly seq: number;
  /** The first line, plus a database driver's `detail` when it says what clashed. */
  readonly summary: string;
  readonly text: string;
  readonly lines: number;
}

/** A log row: a printed line, or the one-line summary standing in for an error. */
export interface ShownEntry extends LogEntry {
  readonly error?: ErrorBlock & { readonly expanded: boolean };
  /** A line of an expanded error, or one that reports a failure by itself. */
  readonly failed?: boolean;
}

/**
 * Folds every printed error into a summary row ahead of its lines, which stay only when `expanded`
 * holds its `seq`. A line followed by a stack frame starts an error; frames, `... 3 more` and the
 * `{ … }` property dump continue it. Each service's lines are folded apart, so interleaving is fine.
 */
export function foldErrors(entries: readonly LogEntry[], expanded: ReadonlySet<number>): ShownEntry[] {
  const members = new Map<number, LogEntry[]>();
  const open = new Map<number, { lines: LogEntry[]; depth: number }>();
  const last = new Map<number, LogEntry>();
  for (const entry of entries) {
    const plain = stripColor(entry.text);
    const block = open.get(entry.source);
    if (block && (block.depth > 0 || FRAME.test(plain) || MORE.test(plain))) {
      block.lines.push(entry);
      block.depth = Math.max(0, block.depth + depthChange(plain));
    } else {
      open.delete(entry.source);
      const before = last.get(entry.source);
      const beforePlain = before && stripColor(before.text);
      if (before && beforePlain?.trim() && !FRAME.test(beforePlain) && FRAME.test(plain)) {
        const lines = [before, entry];
        members.set(before.seq, lines);
        open.set(entry.source, { lines, depth: Math.max(0, depthChange(plain)) });
      }
    }
    last.set(entry.source, entry);
  }

  const hidden = new Set<number>();
  const member = new Set<number>();
  const starts = new Map<number, ShownEntry>();
  for (const [seq, lines] of members) {
    const text = lines.map((line) => stripColor(line.text)).join("\n");
    const detail = lines.map((line) => DETAIL.exec(stripColor(line.text))?.[2]).find(Boolean);
    const head = stripColor(lines[0]?.text ?? "").trim();
    const isOpen = expanded.has(seq);
    starts.set(seq, {
      seq: seq - 0.5,
      source: lines[0]?.source ?? 0,
      text: head,
      error: { seq, summary: detail ? `${head} — ${detail}` : head, text, lines: lines.length, expanded: isOpen },
    });
    for (const line of lines) (isOpen ? member : hidden).add(line.seq);
  }

  const out: ShownEntry[] = [];
  for (const entry of entries) {
    const start = starts.get(entry.seq);
    if (start) out.push(start);
    if (hidden.has(entry.seq)) continue;
    const failed = member.has(entry.seq) || FAILURE.test(stripColor(entry.text));
    out.push(failed ? { ...entry, failed } : entry);
  }
  return out;
}

/** Braces opened minus closed, outside quoted strings. */
function depthChange(line: string) {
  const bare = line.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "");
  return (bare.match(/[{[]/g)?.length ?? 0) - (bare.match(/[}\]]/g)?.length ?? 0);
}
