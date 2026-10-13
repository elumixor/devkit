import { type ChildProcess, spawn } from "node:child_process";
import { freePort } from "../free-port.ts";
import { probePort } from "../wait-port.ts";
import { eachLine } from "./lines.ts";
import { type ServiceSpec, urlOf } from "./processes.ts";

export type ServiceState = "starting" | "ready" | "running" | "stopping" | "stopped" | "exited" | "crashed";

const PROBE_INTERVAL_MS = 400;
/** `bun run` reports being stopped as an error, which it isn't when devkit asked for it. */
const STOPPED_BY_US = /terminated by signal SIG(TERM|INT|KILL)/;
const KILL_GRACE_MS = 3_000;

/** What a service reports back to whoever supervises it. */
export interface ServiceHooks {
  readonly line: (text: string) => void;
  /** A line about the service from devkit itself — readiness, exits, restarts. */
  readonly note: (text: string) => void;
  readonly changed: () => void;
  readonly ready: () => void;
}

/** One dev process: spawns it in its own process group, watches its port, and stops the whole group. */
export class Service {
  readonly spec: ServiceSpec;
  readonly url: string | undefined;
  readonly #hooks: ServiceHooks;
  readonly #env: NodeJS.ProcessEnv;
  #state: ServiceState = "stopped";
  #code: number | null = null;
  #startedAt = 0;
  #readyMs: number | null = null;
  #child: ChildProcess | undefined;
  #closed: Promise<void> = Promise.resolve();
  #run = 0;

  constructor(spec: ServiceSpec, env: NodeJS.ProcessEnv, hooks: ServiceHooks) {
    this.spec = spec;
    this.url = urlOf(spec);
    this.#env = env;
    this.#hooks = hooks;
  }

  get state(): ServiceState {
    return this.#state;
  }
  get code(): number | null {
    return this.#code;
  }
  get startedAt(): number {
    return this.#startedAt;
  }
  get readyMs(): number | null {
    return this.#readyMs;
  }
  get alive(): boolean {
    return this.#state === "starting" || this.#state === "ready" || this.#state === "running";
  }

  start() {
    const run = ++this.#run;
    this.#state = this.spec.port != null ? "starting" : "running";
    this.#code = null;
    this.#readyMs = null;
    this.#startedAt = Date.now();

    // Its own process group, so stopping it also stops whatever `bun run` or `sh -c` started under it.
    const child = spawn(this.spec.command, {
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: this.#env,
    });
    this.#child = child;
    const line = (text: string) => {
      if (!(this.#state === "stopping" && STOPPED_BY_US.test(text))) this.#hooks.line(text);
    };
    eachLine(child.stdout, line);
    eachLine(child.stderr, line);
    child.on("error", (error) => this.#hooks.note(`could not start: ${error.message}`));
    this.#closed = new Promise((done) => {
      child.on("close", (code, signal) => {
        if (run === this.#run) this.#ended(code, signal);
        done();
      });
    });

    if (this.spec.port != null) void this.#watchPort(run, this.spec.port);
    this.#hooks.changed();
  }

  async stop() {
    if (!this.#child || !this.alive) return;
    this.#state = "stopping";
    this.#hooks.changed();
    this.#signal("SIGTERM");
    const force = setTimeout(() => this.#signal("SIGKILL"), KILL_GRACE_MS);
    await this.#closed;
    clearTimeout(force);
  }

  async restart() {
    this.#hooks.note("restarting");
    await this.stop();
    // A server that forked a worker can leave it holding the port after its parent is gone.
    if (this.spec.port != null) await freePort(this.spec.port);
    this.start();
  }

  #ended(code: number | null, signal: NodeJS.Signals | null) {
    const wasStopping = this.#state === "stopping";
    this.#code = code;
    this.#state = wasStopping ? "stopped" : code === 0 ? "exited" : "crashed";
    if (!wasStopping) this.#hooks.note(code === 0 ? "exited" : `crashed (${signal ?? `exit ${code}`})`);
    this.#hooks.changed();
  }

  async #watchPort(run: number, port: number) {
    while (run === this.#run && this.#state === "starting") {
      if (await probePort(port)) {
        if (run !== this.#run || this.#state !== "starting") return;
        this.#state = "ready";
        this.#readyMs = Date.now() - this.#startedAt;
        this.#hooks.note(`ready at ${this.url} in ${(this.#readyMs / 1000).toFixed(1)}s`);
        this.#hooks.changed();
        this.#hooks.ready();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
    }
  }

  #signal(signal: NodeJS.Signals) {
    const pid = this.#child?.pid;
    if (pid == null) return;
    try {
      process.kill(-pid, signal);
    } catch (error) {
      // The group is already gone: exactly what stopping it wanted.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}
