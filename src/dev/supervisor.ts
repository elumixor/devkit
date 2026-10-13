import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { resolve } from "node:path";
import { stripColor } from "../ansi.ts";
import { freePort } from "../free-port.ts";
import { openUrl } from "../wait-port.ts";
import { cleanLine } from "./lines.ts";
import type { ServiceSpec } from "./processes.ts";
import { Service } from "./service.ts";

/** Lines kept in memory for the board; the log files keep everything. */
const MAX_ENTRIES = 10_000;
const TRIM_BATCH = 1_000;
/** `source` of devkit's own lines. */
export const DEVKIT = -1;

export interface LogEntry {
  /** Position in the whole run, so a paused view stays where it is while lines arrive and fall off. */
  readonly seq: number;
  /** Index into `services`, or `DEVKIT`. */
  readonly source: number;
  readonly text: string;
}

export interface SupervisorOptions {
  /** Ask children for colour — they print to a pipe, so they would otherwise drop it. */
  readonly color: boolean;
  /** Open each `open` service's URL the first time its port answers. */
  readonly open: boolean;
  readonly logDir: string;
}

/**
 * Runs every dev service side by side and keeps their output.
 *
 * Nothing here draws: the board and the plain printer both read the same entries and states, and
 * every line also goes to `<logDir>/<label>.log` so an agent can tail a run it cannot see.
 */
export class Supervisor {
  readonly services: readonly Service[];
  readonly logDir: string;
  readonly #files: readonly WriteStream[];
  readonly #open: boolean;
  readonly #entryListeners = new Set<(entry: LogEntry) => void>();
  readonly #changeListeners = new Set<() => void>();
  #entries: LogEntry[] = [];
  #seq = 0;
  #version = 0;
  #opened = new Set<number>();

  constructor(specs: readonly ServiceSpec[], options: SupervisorOptions) {
    this.logDir = options.logDir;
    this.#open = options.open;
    mkdirSync(options.logDir, { recursive: true });
    this.#files = specs.map((spec) =>
      createWriteStream(resolve(options.logDir, `${spec.label.replaceAll(/[^\w.-]/g, "-")}.log`)),
    );
    const env = { ...process.env, ...(options.color ? { FORCE_COLOR: "1" } : {}) };
    this.services = specs.map(
      (spec, i) =>
        new Service(spec, env, {
          line: (raw) => this.#push(i, cleanLine(raw)),
          note: (text) => {
            this.#files[i]?.write(`[devkit] ${text}\n`);
            this.#push(DEVKIT, `${spec.label} ${text}`);
          },
          changed: () => this.#changed(),
          ready: () => this.#ready(i),
        }),
    );
  }

  get entries(): readonly LogEntry[] {
    return this.#entries;
  }

  /** Bumped on every new line or state change — what the board re-renders on. */
  get version(): number {
    return this.#version;
  }

  get allEnded(): boolean {
    return this.services.every((service) => !service.alive && service.state !== "stopping");
  }

  /** Arrow so it can be handed to `useSyncExternalStore` unbound. */
  readonly subscribe = (listener: () => void) => {
    this.#changeListeners.add(listener);
    return () => {
      this.#changeListeners.delete(listener);
    };
  };

  onEntry(listener: (entry: LogEntry) => void) {
    this.#entryListeners.add(listener);
  }

  async start() {
    await Promise.all(
      this.services.map(async ({ spec }) => {
        if (spec.port == null) return;
        const killed = await freePort(spec.port);
        if (killed.length) this.say(`freed port ${spec.port} (killed ${killed.join(", ")})`);
      }),
    );
    for (const service of this.services) service.start();
  }

  /** Restart one service, or all of them. */
  async restart(index?: number) {
    const targets = index == null ? this.services : this.services.slice(index, index + 1);
    await Promise.all(targets.map((service) => service.restart()));
  }

  async stop() {
    await Promise.all(this.services.map((service) => service.stop()));
    await Promise.all(this.#files.map((file) => new Promise((done) => file.end(done))));
  }

  clear() {
    this.#entries = [];
    this.#changed();
  }

  say(text: string) {
    this.#push(DEVKIT, text);
  }

  async openService(index: number) {
    const url = this.services[index]?.url;
    if (!url) return;
    await openUrl(url).then(
      () => this.say(`opened ${url}`),
      (error: Error) => this.say(`could not open ${url}: ${error.message}`),
    );
  }

  #push(source: number, text: string) {
    if (!stripColor(text).trim()) return;
    const entry = { seq: this.#seq++, source, text };
    this.#entries.push(entry);
    if (this.#entries.length > MAX_ENTRIES + TRIM_BATCH) this.#entries = this.#entries.slice(-MAX_ENTRIES);
    if (source !== DEVKIT) this.#files[source]?.write(`${stripColor(text)}\n`);
    for (const listener of this.#entryListeners) listener(entry);
    this.#changed();
  }

  #ready(index: number) {
    if (!this.#open || !this.services[index]?.spec.open || this.#opened.has(index)) return;
    this.#opened.add(index);
    void this.openService(index);
  }

  #changed() {
    this.#version++;
    for (const listener of this.#changeListeners) listener();
  }
}
