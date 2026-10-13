import { relative } from "node:path";
import { paint, stripColor } from "../ansi.ts";
import { DEVKIT, type Supervisor } from "./supervisor.ts";

/**
 * Prefixed line-by-line output for anything that is not a person at a terminal — an agent's shell,
 * CI, a pipe. URLs come first, every state change is its own `devkit` line, and once every server
 * answers one line lists them all, so a reader that only greps still finds where things are.
 */
export function printPlain(supervisor: Supervisor, color: boolean) {
  const { services } = supervisor;
  const width = Math.max("devkit".length, ...services.map((service) => service.spec.label.length));
  const tag = (source: number) => {
    const label = (source === DEVKIT ? "devkit" : (services[source]?.spec.label ?? "")).padEnd(width);
    return color ? paint(label, source === DEVKIT ? "gray" : (services[source]?.spec.color ?? "white")) : label;
  };
  const say = (text: string) => console.log(`${tag(DEVKIT)} │ ${text}`);

  say(`dev · logs in ${relative(process.cwd(), supervisor.logDir)}`);
  for (const service of services) if (service.url) say(`  ${service.spec.label.padEnd(width)}  ${service.url}`);

  supervisor.onEntry((entry) => console.log(`${tag(entry.source)} │ ${color ? entry.text : stripColor(entry.text)}`));

  const servers = services.filter((service) => service.url);
  let announced = false;
  supervisor.subscribe(() => {
    if (announced || !servers.length || servers.some((service) => service.state !== "ready")) return;
    announced = true;
    say(`all ready: ${servers.map((service) => `${service.spec.label} ${service.url}`).join(" · ")}`);
  });
}
