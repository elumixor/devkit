import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type DeployTarget, loadConfig } from "./config.ts";

const PALETTE: readonly string[] = ["magenta", "cyan", "yellow", "green", "blue", "red"];
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
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;
const TAIL_ON_FAILURE = 25;

const paint = (text: string, color: string) => `\x1b[${COLORS[color] ?? "37"}m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;

type Status = "waiting" | "running" | "done" | "failed" | "skipped";

/** One target's progress, and everything the board needs to draw its line. */
interface Job {
  target: DeployTarget;
  label: string;
  color: string;
  status: Status;
  note: string;
  startedAt?: number;
  endedAt?: number;
  lines: string[];
  logPath: string;
}

/**
 * Run the configured deploys, in parallel where they don't depend on each other.
 *
 * A deploy is several long builds that each print thousands of lines, and interleaving all of it
 * is unreadable — so on a terminal this draws one line per target (what it's doing, for how long)
 * and keeps the full output in `.devkit/deploy/<name>.log`, printing the tail of whichever target
 * failed. Anywhere else — CI, a pipe, a log file — it falls back to prefixed streaming, because a
 * redrawing board in a file is worse than useless.
 */
export async function runDeploy(only: string[], options: { dry?: boolean; verbose?: boolean } = {}) {
  const { deploy } = loadConfig();
  if (!deploy?.length) throw new Error('No "devkit.deploy" targets in package.json');

  const unknown = only.filter((name) => !deploy.some((target) => target.name === name));
  if (unknown.length) {
    throw new Error(`Unknown target${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
  }

  for (const target of deploy) {
    const missing = (target.needs ?? []).filter((need) => !deploy.some((other) => other.name === need));
    if (missing.length) throw new Error(`${target.name} needs unknown target${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
  }

  const jobs = selected(deploy, only).map(toJob);
  if (options.dry) return printPlan(jobs);

  const logDir = resolve(process.cwd(), ".devkit/deploy");
  mkdirSync(logDir, { recursive: true });

  const live = Boolean(process.stdout.isTTY) && !options.verbose;
  console.log(bold(`\ndeploying ${jobs.map((job) => job.label).join(", ")}`) + dim(live ? `  ·  logs in ${"./.devkit/deploy"}` : ""));
  console.log();
  const board = live ? startBoard(jobs) : null;

  // Each target waits on the gates of the targets it needs, so the graph runs itself: independent
  // targets start together, dependents start the moment their last dependency lands.
  const gates = new Map(jobs.map((job) => [job.label, gate()]));

  const started = Date.now();
  await Promise.all(
    jobs.map(async (job) => {
      const needs = (job.target.needs ?? []).map((name) => jobs.find((other) => other.label === name)) as Job[];
      await Promise.all(needs.map((need) => gates.get(need.label)?.promise));
      await runJob(job, needs, live);
      gates.get(job.label)?.open();
    }),
  );
  board?.stop();

  report(jobs, Date.now() - started);
  if (jobs.some((job) => job.status !== "done")) process.exitCode = 1;
}

/** The targets asked for, plus whatever they depend on — a target can't run without its needs. */
function selected(targets: DeployTarget[], only: string[]) {
  if (!only.length) return targets;
  const wanted = new Set(only);
  let grew = true;
  while (grew) {
    grew = false;
    for (const target of targets) {
      if (!wanted.has(target.name)) continue;
      for (const need of target.needs ?? []) {
        if (!wanted.has(need)) {
          wanted.add(need);
          grew = true;
        }
      }
    }
  }
  return targets.filter((target) => wanted.has(target.name));
}

function toJob(target: DeployTarget, index: number): Job {
  return {
    target,
    label: target.name,
    color: target.color ?? (PALETTE[index % PALETTE.length] as string),
    status: "waiting",
    note: target.needs?.length ? `waiting for ${target.needs.join(", ")}` : "",
    lines: [],
    logPath: resolve(process.cwd(), ".devkit/deploy", `${target.name}.log`),
  };
}

/** Runs one target's command to completion, unless something it needed didn't get there. */
async function runJob(job: Job, needs: Job[], live: boolean) {
  const blocker = needs.find((need) => need.status !== "done");
  if (blocker) {
    job.status = "skipped";
    job.note = `skipped — ${blocker.label} ${blocker.status === "failed" ? "failed" : "never ran"}`;
    return;
  }

  job.status = "running";
  job.startedAt = Date.now();
  job.note = job.target.command;

  const code = await new Promise<number>((done) => {
    const child = spawn(job.target.command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) {
      let rest = "";
      stream.on("data", (chunk: Buffer) => {
        const parts = (rest + chunk.toString()).split("\n");
        rest = parts.pop() ?? "";
        for (const line of parts) {
          job.lines.push(line);
          job.note = line.trim() || job.note;
          if (!live) console.log(`${paint(`[${job.label}]`, job.color)} ${line}`);
        }
      });
    }
    child.on("close", (status) => done(status ?? 1));
  });

  job.endedAt = Date.now();
  job.status = code === 0 ? "done" : "failed";
  job.note = code === 0 ? "done" : `exit ${code}`;
  writeFileSync(job.logPath, `${job.lines.join("\n")}\n`);
}

/** Redraws the board until stopped. One line per target, in the order they were configured. */
function startBoard(jobs: Job[]) {
  let drawn = 0;
  let frame = 0;

  const draw = () => {
    // A pty with no window size reports 0 — treat that as a sane default rather than clipping to nothing.
    const width = process.stdout.columns || 100;
    const pad = Math.max(...jobs.map((job) => job.label.length));
    const lines = jobs.map((job) => {
      const mark =
        job.status === "running"
          ? paint(SPINNER[frame % SPINNER.length] as string, job.color)
          : job.status === "done"
            ? paint("✓", "green")
            : job.status === "failed"
              ? paint("✗", "red")
              : job.status === "skipped"
                ? dim("–")
                : dim("·");
      const time = job.startedAt ? dim(` ${elapsed(job)}`) : "";
      const head = `${mark} ${paint(job.label.padEnd(pad), job.color)}${time}  `;
      // The note is whatever the target last printed, so it has to be cut to the terminal rather
      // than wrapped — a wrapped line breaks the cursor arithmetic that redraws this block.
      const room = Math.max(10, width - visibleLength(head) - 1);
      return head + dim(clip(job.note, room));
    });

    process.stdout.write(`${drawn ? `\x1b[${drawn}A` : ""}${lines.map((line) => `\x1b[2K${line}`).join("\n")}\n`);
    drawn = lines.length;
    frame++;
  };

  process.stdout.write("\x1b[?25l");
  draw();
  const timer = setInterval(draw, FRAME_MS);

  return {
    stop() {
      clearInterval(timer);
      draw();
      process.stdout.write("\x1b[?25h");
    },
  };
}

function report(jobs: Job[], total: number) {
  const failed = jobs.filter((job) => job.status === "failed");
  for (const job of failed) {
    console.log(`\n${paint(`── ${job.label} failed`, "red")} ${dim(job.logPath)}`);
    for (const line of job.lines.slice(-TAIL_ON_FAILURE)) console.log(dim(`   ${line}`));
  }

  const done = jobs.filter((job) => job.status === "done").length;
  const skipped = jobs.filter((job) => job.status === "skipped").length;
  const parts = [
    failed.length ? paint(`${failed.length} failed`, "red") : paint("all good", "green"),
    skipped ? dim(`${skipped} skipped`) : "",
    dim(duration(total)),
  ].filter(Boolean);
  console.log(`\n${bold(`${done}/${jobs.length} deployed`)} · ${parts.join(" · ")}\n`);
}

function printPlan(jobs: Job[]) {
  console.log(bold("\ndeploy plan\n"));
  for (const job of jobs) {
    const after = job.target.needs?.length ? dim(` after ${job.target.needs.join(", ")}`) : "";
    console.log(`  ${paint(job.label, job.color)}${after}\n    ${dim(job.target.command)}`);
  }
  console.log();
}

/** A promise plus the handle that settles it — one per target, opened when that target ends. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const elapsed = (job: Job) => duration((job.endedAt ?? Date.now()) - (job.startedAt ?? Date.now()));

function duration(ms: number) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

// Colour codes take no space on screen, so the board has to measure what a reader would see.
// biome-ignore lint/suspicious/noControlCharactersInRegex: an escape sequence is the thing being matched
const ANSI = /\x1b\[[0-9;]*m/g;
const visibleLength = (text: string) => text.replace(ANSI, "").length;
const clip = (text: string, room: number) => (text.length <= room ? text : `${text.slice(0, room - 1)}…`);
