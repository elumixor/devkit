/** @jsxImportSource react */
import { relative } from "node:path";
import { Box, render, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import wrapAnsi from "wrap-ansi";
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
  const { cols, rows } = useTerminalSize();
  useThrottledVersion(supervisor);
  const frame = useFrame(supervisor.services.some((s) => s.state === "starting" || s.state === "stopping"));

  const [focus, setFocus] = useState<number | null>(null);
  /** `seq` the view ends before while scrolled back; `null` follows the newest line. */
  const [end, setEnd] = useState<number | null>(null);
  const [quitting, setQuitting] = useState(false);

  const services = supervisor.services;
  const logRows = Math.max(1, rows - CHROME_ROWS - SPARE_ROWS - services.length);
  const labelWidth = Math.max("devkit".length, ...services.map((s) => s.spec.label.length));
  const textWidth = Math.max(MIN_LOG_WIDTH, cols - labelWidth - 3);

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

  const scroll = (by: number) => {
    const next = Math.min(shown.length, Math.max(firstFullScreen(shown, logRows, textWidth), endIndex + by));
    setEnd(next >= shown.length ? null : (shown[next]?.seq ?? null));
  };

  const quit = () => {
    if (quitting) return;
    setQuitting(true);
    void supervisor.stop().then(() => exit());
  };

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) return quit();
    // Before Escape: Ink flags `escape` on every escape sequence, arrows and paging included.
    if (key.upArrow || input === "k") return scroll(-1);
    if (key.downArrow || input === "j") return scroll(1);
    if (key.pageUp) return scroll(-(logRows - 1));
    if (key.pageDown) return scroll(logRows - 1);
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
        {lines.map((line) => (
          <Box key={line.key}>
            <Text color={line.color}>{(line.first ? line.label : "").padEnd(labelWidth)}</Text>
            <Text dimColor> │ </Text>
            <Text wrap="truncate-end">{line.text}</Text>
          </Box>
        ))}
      </Box>
      <Footer count={services.length} newer={end == null ? 0 : newer} />
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

function Footer({ count, newer }: { readonly count: number; readonly newer: number }) {
  const keys = [
    [count > 1 ? `1-${count}` : "1", "focus"],
    ["a", "all"],
    ["o", "open"],
    ["r", "restart"],
    ["c", "clear"],
    ["↑↓ PgUp PgDn", "scroll"],
    ["q", "quit"],
  ];
  return (
    <Text wrap="truncate-end">
      {" "}
      {newer > 0 && <Text color="yellow">paused · {newer} newer · f to follow </Text>}
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
      out.push({ key: `${entry.seq}:${row}`, text: rows[row] ?? "", first: row === 0, ...who(entry.source) });
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
