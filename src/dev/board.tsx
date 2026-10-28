/** @jsxImportSource react */
import { relative } from "node:path";
import { Box, type Key, render, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import wrapAnsi from "wrap-ansi";
import { stripColor } from "../ansi.ts";
import { copyToClipboard } from "./clipboard.ts";
import type { Service, ServiceState } from "./service.ts";
import { DEVKIT, type LogEntry, type Supervisor } from "./supervisor.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;
/** Lines can arrive by the thousand during a compile; the board redraws at most this often. */
const REDRAW_MS = 50;
/** Title, separator and key hints around the log. */
const CHROME_ROWS = 3;
/** Ink falls back to clearing the whole screen once a frame fills it, which flickers. */
const SPARE_ROWS = 1;
const MIN_LOG_WIDTH = 20;
const FLASH_MS = 2000;
const AUTOSCROLL_MS = 50;
const WHEEL_LINES = 3;
/** SGR mouse button codes: motion adds 32, the wheel is 64 and 65. */
const LEFT = 0;
const LEFT_DRAG = 32;
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
/** Button presses, drags and releases, reported as SGR coordinates. */
const MOUSE_ON = "\x1b[?1002h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1002l\x1b[?1006l";

const MARK: Record<ServiceState, { glyph: string; color: string }> = {
  starting: { glyph: "", color: "yellow" },
  ready: { glyph: "●", color: "green" },
  running: { glyph: "●", color: "green" },
  stopping: { glyph: "", color: "gray" },
  stopped: { glyph: "○", color: "gray" },
  exited: { glyph: "○", color: "gray" },
  crashed: { glyph: "✗", color: "red" },
};

/**
 * The interactive dev screen: every service's URL and state pinned at the top, the merged log
 * below. Runs in the alternate screen, like `less`, and gives the terminal back on quit.
 */
export async function runBoard(supervisor: Supervisor, title: string) {
  const app = render(<Board supervisor={supervisor} title={title} />, {
    alternateScreen: true,
    exitOnCtrlC: false,
  });
  await app.waitUntilExit();
}

function Board({ supervisor, title }: { readonly supervisor: Supervisor; readonly title: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { cols, rows } = useTerminalSize();
  useThrottledVersion(supervisor);
  useMouseReporting(stdout);
  const frame = useFrame(supervisor.services.some((s) => s.state === "starting" || s.state === "stopping"));

  const [focus, setFocus] = useState<number | null>(null);
  /** `seq` the view ends before while scrolled back; `null` follows the newest line. */
  const [end, setEnd] = useState<number | null>(null);
  const [quitting, setQuitting] = useState(false);
  /** `seq` the selection started at; `null` outside visual mode. */
  const [anchor, setAnchor] = useState<number | null>(null);
  const [cursor, setCursor] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  /** The first `g` of `gg`. */
  const pendingG = useRef(false);
  /** Whether the view followed new lines before visual mode paused it. */
  const resumeFollow = useRef(false);
  /** Rows per tick the view scrolls while a drag is held above or below the log. */
  const autoscroll = useRef(0);
  const step = useRef(() => {});

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  useEffect(() => {
    if (!dragging) return;
    const timer = setInterval(() => step.current(), AUTOSCROLL_MS);
    return () => clearInterval(timer);
  }, [dragging]);

  const services = supervisor.services;
  const logRows = Math.max(1, rows - CHROME_ROWS - SPARE_ROWS - services.length);
  const logTop = services.length + 3;
  const labelWidth = Math.max("devkit".length, ...services.map((s) => s.spec.label.length));
  const textWidth = Math.max(MIN_LOG_WIDTH, cols - labelWidth - 3);
  const halfPage = Math.max(1, Math.floor(logRows / 2));

  const shown = supervisor.entries.filter(
    (entry) => focus == null || entry.source === focus || entry.source === DEVKIT,
  );
  const endIndex = end == null ? shown.length : countBefore(shown, end);
  const who = (source: number) =>
    source === DEVKIT
      ? { label: "devkit", color: "gray" }
      : { label: services[source]?.spec.label ?? "", color: services[source]?.spec.color ?? "white" };
  const lines = tail(shown, endIndex, logRows, textWidth, who);
  const newer = shown.length - endIndex;

  const visual = anchor != null;
  const low = Math.min(anchor ?? 0, cursor);
  const high = Math.max(anchor ?? 0, cursor);
  const markOf = (seq: number) =>
    !visual || seq < low || seq > high ? undefined : seq === cursor ? "cursor" : "selected";

  const scroll = (by: number) => {
    const next = Math.min(shown.length, Math.max(firstFullScreen(shown, logRows, textWidth), endIndex + by));
    setEnd(next >= shown.length ? null : (shown[next]?.seq ?? null));
  };

  /** Ends the view before `index`, staying put at the bottom instead of following. */
  const showUntil = (index: number) =>
    setEnd(index >= shown.length ? (shown.at(-1)?.seq ?? -1) + 1 : (shown[index]?.seq ?? null));

  const moveCursor = (index: number) => {
    const to = Math.min(shown.length - 1, Math.max(0, index));
    const entry = shown[to];
    if (!entry) return;
    setCursor(entry.seq);
    if (to >= endIndex) showUntil(to + 1);
    else if (to < firstVisible(shown, endIndex, logRows, textWidth)) showUntil(endFor(shown, to, logRows, textWidth));
  };

  const startVisual = (seq: number) => {
    if (!visual) resumeFollow.current = end == null;
    showUntil(endIndex);
    setAnchor(seq);
    setCursor(seq);
  };

  const stopVisual = () => {
    setAnchor(null);
    setDragging(false);
    autoscroll.current = 0;
    if (resumeFollow.current) setEnd(null);
  };

  const yank = (entries: readonly LogEntry[]) => {
    if (entries.length === 0) return;
    copyToClipboard(entries.map((entry) => stripColor(entry.text)).join("\n"), stdout);
    setFlash(`copied ${entries.length} line${entries.length === 1 ? "" : "s"}`);
  };

  const yankSelection = () => {
    yank(shown.filter((entry) => entry.seq >= low && entry.seq <= high));
    stopVisual();
  };

  const cursorIndex = Math.min(shown.length - 1, countBefore(shown, cursor));
  step.current = () => {
    if (autoscroll.current) moveCursor(cursorIndex + autoscroll.current);
  };

  const quit = () => {
    if (quitting) return;
    setQuitting(true);
    void supervisor.stop().then(() => exit());
  };

  const onMouse = ({ button, row, release }: MouseEvent) => {
    const at = row - logTop;
    if (button === WHEEL_UP || button === WHEEL_DOWN) {
      const by = button === WHEEL_UP ? -WHEEL_LINES : WHEEL_LINES;
      return visual ? moveCursor(cursorIndex + by) : scroll(by);
    }
    if (release) {
      if (!dragging) return;
      return anchor === cursor ? stopVisual() : yankSelection();
    }
    if (button === LEFT) {
      const line = lines[at];
      if (!line) return;
      startVisual(line.seq);
      return setDragging(true);
    }
    if (button === LEFT_DRAG && dragging) {
      autoscroll.current = at < 0 ? at : at >= logRows ? at - logRows + 1 : 0;
      const line = lines[Math.min(lines.length - 1, Math.max(0, at))];
      if (!autoscroll.current && line) setCursor(line.seq);
    }
  };

  /** `times` repeats a movement, for a key held down faster than the board redraws. */
  const onKey = (input: string, key: Key, times = 1) => {
    const gg = input === "g" && pendingG.current;
    pendingG.current = input === "g" && !gg;
    if (input === "q" || (key.ctrl && input === "c")) return quit();

    // Before Escape: Ink flags `escape` on every escape sequence, arrows and paging included.
    if (visual) {
      if (input === "y" || key.return) return yankSelection();
      if (key.upArrow || input === "k") return moveCursor(cursorIndex - times);
      if (key.downArrow || input === "j") return moveCursor(cursorIndex + times);
      if (input === "u") return moveCursor(cursorIndex - halfPage * times);
      if (input === "d") return moveCursor(cursorIndex + halfPage * times);
      if (key.pageUp || (key.ctrl && input === "b")) return moveCursor(cursorIndex - (logRows - 1) * times);
      if (key.pageDown || (key.ctrl && input === "f")) return moveCursor(cursorIndex + (logRows - 1) * times);
      if (gg || key.home) return moveCursor(0);
      if (input === "G" || key.end) return moveCursor(shown.length - 1);
      if (key.escape || input === "v" || input === "V") stopVisual();
      return;
    }

    // Before Escape: Ink flags `escape` on every escape sequence, arrows and paging included.
    if (key.upArrow || input === "k") return scroll(-times);
    if (key.downArrow || input === "j") return scroll(times);
    if (input === "u") return scroll(-halfPage * times);
    if (input === "d") return scroll(halfPage * times);
    if (key.pageUp || (key.ctrl && input === "b")) return scroll(-(logRows - 1) * times);
    if (key.pageDown || (key.ctrl && input === "f")) return scroll((logRows - 1) * times);
    if (gg || key.home) return scroll(-shown.length);
    if (input === "v" || input === "V") {
      const last = shown[endIndex - 1];
      return last && startVisual(last.seq);
    }
    if (input === "y") return yank(shown.slice(firstVisible(shown, endIndex, logRows, textWidth), endIndex));
    const digit = Number(input);
    if (Number.isInteger(digit) && digit >= 1 && digit <= services.length) {
      setFocus(focus === digit - 1 ? null : digit - 1);
      return setEnd(null);
    }
    if (input === "a" || input === "0" || key.escape) {
      setFocus(null);
      return setEnd(null);
    }
    if (input === "o") return void supervisor.openService(openTarget(services, focus));
    if (input === "r") return void supervisor.restart(focus ?? undefined);
    if (input === "c") {
      supervisor.clear();
      return setEnd(null);
    }
    if (key.end || input === "G" || input === "f") setEnd(null);
  };

  useInput((input, key) => {
    const mouse = parseMouse(input);
    if (mouse) return onMouse(mouse);
    // Keys typed faster than the board redraws arrive together: `gg`, or `jjj` from a held key.
    if (input.length < 2 || !/^\w+$/.test(input)) return onKey(input, key);
    for (const [run, char = ""] of input.matchAll(/(\w)\1*/g)) {
      if (char === "g") for (const _ of run) onKey(char, key);
      else onKey(char, key, run.length);
    }
  });

  return (
    <Box flexDirection="column" width={cols} height={rows - SPARE_ROWS}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold> devkit dev</Text>
          <Text dimColor> · {title}</Text>
          {quitting && <Text color="yellow"> · stopping…</Text>}
        </Text>
        <Text dimColor>logs in {relative(process.cwd(), supervisor.logDir)} </Text>
      </Box>
      {services.map((service, i) => (
        <ServiceRow
          key={service.spec.label}
          service={service}
          index={i}
          focused={focus === i}
          labelWidth={labelWidth}
          frame={frame}
        />
      ))}
      <Text dimColor wrap="truncate-end">
        {`── ${focus == null ? "all" : services[focus]?.spec.label} `.padEnd(cols, "─")}
      </Text>
      <Box flexDirection="column" height={logRows} overflow="hidden">
        {lines.map((line) => {
          const mark = markOf(line.seq);
          return (
            <Box key={line.key}>
              <Text color={line.color}>{(line.first ? line.label : "").padEnd(labelWidth)}</Text>
              {mark ? (
                <Text color="yellow">{mark === "cursor" && line.first ? " ▶ " : " ┃ "}</Text>
              ) : (
                <Text dimColor> │ </Text>
              )}
              {/* Inverse on the plain text: a child's own colour resets would cut the highlight short. */}
              {mark ? (
                <Text inverse wrap="truncate-end">
                  {stripColor(line.text) || " "}
                </Text>
              ) : (
                <Text wrap="truncate-end">{line.text}</Text>
              )}
            </Box>
          );
        })}
      </Box>
      <Footer
        count={services.length}
        newer={end == null ? 0 : newer}
        selected={visual ? shown.filter((entry) => entry.seq >= low && entry.seq <= high).length : null}
        flash={flash}
      />
    </Box>
  );
}

function ServiceRow({
  service,
  index,
  focused,
  labelWidth,
  frame,
}: {
  readonly service: Service;
  readonly index: number;
  readonly focused: boolean;
  readonly labelWidth: number;
  readonly frame: number;
}) {
  const mark = MARK[service.state];
  return (
    <Text wrap="truncate-end">
      {" "}
      <Text color={mark.color}>{mark.glyph || SPINNER[frame % SPINNER.length]}</Text>
      <Text dimColor> {index + 1} </Text>
      <Text color={service.spec.color} bold={focused} inverse={focused}>
        {service.spec.label.padEnd(labelWidth)}
      </Text>
      {"  "}
      <Text bold>{(service.url ?? "").padEnd(24)}</Text>
      <StateText service={service} />
    </Text>
  );
}

function StateText({ service }: { readonly service: Service }) {
  const since = seconds(Date.now() - service.startedAt);
  switch (service.state) {
    case "starting":
      return <Text color="yellow">starting {since}</Text>;
    case "ready":
      return (
        <Text color="green">
          ready<Text dimColor> in {seconds(service.readyMs ?? 0)}</Text>
        </Text>
      );
    case "running":
      return <Text color="green">running</Text>;
    case "stopping":
      return <Text dimColor>stopping…</Text>;
    case "stopped":
      return <Text dimColor>stopped · r to start</Text>;
    case "exited":
      return <Text dimColor>exited · r to start</Text>;
    case "crashed":
      return (
        <Text color="red">
          crashed{service.code != null ? ` (exit ${service.code})` : ""}
          <Text dimColor> · r to restart</Text>
        </Text>
      );
  }
}

function Footer({
  count,
  newer,
  selected,
  flash,
}: {
  readonly count: number;
  readonly newer: number;
  /** Lines in the visual selection; `null` outside visual mode. */
  readonly selected: number | null;
  readonly flash: string | null;
}) {
  const keys =
    selected == null
      ? [
          [count > 1 ? `1-${count}` : "1", "focus"],
          ["a", "all"],
          ["o", "open"],
          ["r", "restart"],
          ["c", "clear"],
          ["jk ud gg G", "scroll"],
          ["v", "select"],
          ["y", "copy"],
          ["q", "quit"],
        ]
      : [
          ["jk ud gg G", "move"],
          ["y", "copy"],
          ["esc", "cancel"],
        ];
  return (
    <Text wrap="truncate-end">
      {" "}
      {flash && <Text color="green">{flash} </Text>}
      {selected != null && <Text color="yellow">VISUAL · {selected} selected </Text>}
      {selected == null && newer > 0 && <Text color="yellow">paused · {newer} newer · f to follow </Text>}
      {keys.map(([key, label]) => (
        <Text key={label}>
          <Text bold>{key}</Text>
          <Text dimColor> {label} </Text>
        </Text>
      ))}
    </Text>
  );
}

interface LogLine {
  readonly key: string;
  readonly seq: number;
  readonly label: string;
  readonly color: string;
  readonly text: string;
  /** Only an entry's first wrapped row carries its label. */
  readonly first: boolean;
}

/** The last `count` screen rows of `entries[0, endIndex)`, wrapped to `width`. */
function tail(
  entries: readonly LogEntry[],
  endIndex: number,
  count: number,
  width: number,
  who: (source: number) => { label: string; color: string },
): LogLine[] {
  const out: LogLine[] = [];
  for (let i = endIndex - 1; i >= 0 && out.length < count; i--) {
    const entry = entries[i] as LogEntry;
    const rows = wrapAnsi(entry.text, width, { hard: true, trim: false }).split("\n");
    for (let row = rows.length - 1; row >= 0 && out.length < count; row--)
      out.push({
        key: `${entry.seq}:${row}`,
        seq: entry.seq,
        text: rows[row] ?? "",
        first: row === 0,
        ...who(entry.source),
      });
  }
  return out.reverse();
}

const heightOf = (entry: LogEntry, width: number) =>
  wrapAnsi(entry.text, width, { hard: true, trim: false }).split("\n").length;

/** The fewest leading entries that fill the log — scrolling back further would only show blank rows. */
function firstFullScreen(entries: readonly LogEntry[], rows: number, width: number) {
  let filled = 0;
  for (let i = 0; i < entries.length; i++) {
    filled += heightOf(entries[i] as LogEntry, width);
    if (filled >= rows) return i + 1;
  }
  return entries.length;
}

/** The first entry `entries[0, endIndex)` shows whole, so a cursor there needs no scrolling. */
function firstVisible(entries: readonly LogEntry[], endIndex: number, rows: number, width: number) {
  let filled = 0;
  let i = endIndex;
  while (i > 0 && filled < rows) filled += heightOf(entries[--i] as LogEntry, width);
  return Math.min(Math.max(0, endIndex - 1), filled > rows ? i + 1 : i);
}

/** Where a view must end to show `entries[start]` on its top row. */
function endFor(entries: readonly LogEntry[], start: number, rows: number, width: number) {
  let filled = 0;
  let i = start;
  while (i < entries.length && filled + heightOf(entries[i] as LogEntry, width) <= rows)
    filled += heightOf(entries[i++] as LogEntry, width);
  return Math.max(i, start + 1);
}

/** How many entries come before `seq` — entries are in `seq` order. */
function countBefore(entries: readonly LogEntry[], seq: number) {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((entries[mid] as LogEntry).seq < seq) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** The focused service, else the one marked `open`, else the first with a URL. */
function openTarget(services: readonly Service[], focus: number | null) {
  if (focus != null) return focus;
  const marked = services.findIndex((service) => service.url && service.spec.open);
  return marked >= 0 ? marked : services.findIndex((service) => service.url);
}

interface MouseEvent {
  readonly button: number;
  /** 1-based screen row. */
  readonly row: number;
  readonly release: boolean;
}

/** Ink hands an SGR mouse report to `useInput` whole, minus its escape. */
function parseMouse(input: string): MouseEvent | undefined {
  const match = /^\[<(\d+);\d+;(\d+)([Mm])$/.exec(input);
  if (!match) return undefined;
  return { button: Number(match[1]), row: Number(match[2]), release: match[3] === "m" };
}

/**
 * Takes the mouse from the terminal so a drag can select and scroll the log. The terminal's own
 * selection stays one modifier away (Option on macOS, Shift elsewhere).
 */
function useMouseReporting(stdout: NodeJS.WriteStream) {
  useEffect(() => {
    if (!stdout.isTTY) return;
    const off = () => stdout.write(MOUSE_OFF);
    stdout.write(MOUSE_ON);
    process.once("exit", off);
    return () => {
      process.off("exit", off);
      off();
    };
  }, [stdout]);
}

function useThrottledVersion(supervisor: Supervisor) {
  const subscribe = useMemo(
    () => (notify: () => void) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = supervisor.subscribe(() => {
        timer ??= setTimeout(() => {
          timer = undefined;
          notify();
        }, REDRAW_MS);
      });
      return () => {
        unsubscribe();
        clearTimeout(timer);
      };
    },
    [supervisor],
  );
  return useSyncExternalStore(subscribe, () => supervisor.version);
}

/** Ticks while something is in motion, for spinners and the "starting 3s" clock. */
function useFrame(active: boolean) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setFrame((n) => n + 1), FRAME_MS);
    return () => clearInterval(timer);
  }, [active]);
  return frame;
}

function useTerminalSize() {
  const { stdout } = useStdout();
  // A pty with no window size reports 0 — fall back to something drawable rather than nothing.
  const read = () => ({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const onResize = () => setSize(read());
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  });
  return size;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
