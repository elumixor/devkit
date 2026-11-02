// The Devkit Cloud dashboard: what is live, how it did today, its deploys and its logs. Everything
// comes from /api/* on this same host; the token is kept in this browser only.
const TOKEN_KEY = "dk.dashboard.token";
const REFRESH_MS = 60_000;

const $ = (selector) => document.querySelector(selector);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
};

const state = { token: localStorage.getItem(TOKEN_KEY) ?? "", selected: null, view: "deploys" };

async function api(path, params = {}) {
  const query = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== "")));
  const response = await fetch(`/api/${path}${query.size ? `?${query}` : ""}`, {
    headers: { authorization: `Bearer ${state.token}` },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.statusMessage ?? body.message ?? `${response.status} ${response.statusText}`);
  }
  return response.json();
}

function message(text, ms = 4000) {
  const node = $("#message");
  node.textContent = text;
  node.hidden = false;
  clearTimeout(message.timer);
  message.timer = setTimeout(() => {
    node.hidden = true;
  }, ms);
}

function age(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function renderProjects(projects) {
  const root = $("#projects");
  root.replaceChildren();
  if (!projects.length) return root.append(el("p", { class: "empty" }, "Nothing deployed yet."));
  for (const project of projects) {
    root.append(
      el(
        "article",
        { class: "project" },
        el("div", { class: "project-name" }, project.project),
        ...project.stages.map(renderStage),
      ),
    );
  }
}

function renderStage(stage) {
  const health = !stage.current ? "" : stage.metrics.errors ? "bad" : "ok";
  const open = (view) => () => select(stage, view);
  return el(
    "div",
    { class: "stage" },
    el("div", { class: "name" }, el("span", { class: `dot ${health}` }), stage.stage),
    el(
      "div",
      {},
      el("a", { class: "url", href: `https://${stage.hostnames[0]}`, target: "_blank", rel: "noreferrer" }, stage.hostnames[0]),
      stage.hostnames.length > 1 ? el("span", { class: "muted" }, ` +${stage.hostnames.length - 1}`) : null,
    ),
    el(
      "div",
      { class: "actions" },
      el("button", { onclick: open("deploys") }, "Deploys"),
      el("button", { onclick: open("logs") }, "Logs"),
    ),
    el("div", {}),
    el(
      "div",
      { class: "deploy" },
      stage.current ? `${stage.current.deployId} · ${age(stage.current.since)}` : "not deployed",
      stage.live ? el("span", { class: "muted" }, `  ${stage.live.commit.slice(0, 7)} ${stage.live.message}`) : null,
    ),
    el(
      "div",
      { class: "metrics" },
      el("span", {}, `${stage.metrics.calls} calls`),
      el("span", { class: stage.metrics.errors ? "err" : "" }, `${stage.metrics.errors} errors`),
      el("span", {}, `p95 ${stage.metrics.p95ms} ms`),
      el("span", { class: "muted" }, "last 24 h"),
    ),
  );
}

async function select(stage, view) {
  state.selected = stage;
  state.view = view;
  $("#detail").hidden = false;
  $("main").classList.add("with-detail");
  $("#detail-title").textContent = `${stage.project} · ${stage.stage}`;
  for (const button of document.querySelectorAll("[data-view]")) button.classList.toggle("active", button.dataset.view === view);
  $("#deploys-view").hidden = view !== "deploys";
  $("#logs-view").hidden = view !== "logs";
  if (view === "deploys") await loadDeploys();
  else await loadLogs();
}

async function loadDeploys() {
  const { project, stage } = state.selected;
  const root = $("#deploys-view");
  root.replaceChildren(el("p", { class: "empty" }, "Loading…"));
  try {
    const deploys = await api("deploys", { project, stage, limit: 20 });
    if (!deploys.length) return root.replaceChildren(el("p", { class: "empty" }, "No deploys."));
    root.replaceChildren(
      el(
        "table",
        {},
        el("thead", {}, el("tr", {}, ...["Deploy", "Status", "When", "Commit", "By", "Message"].map((h) => el("th", {}, h)))),
        el(
          "tbody",
          {},
          ...deploys.map((deploy) =>
            el(
              "tr",
              {},
              el("td", { class: "id" }, deploy.id),
              el("td", { class: "status" }, el("span", { class: `dot ${statusClass(deploy.status)}` }), deploy.status),
              el("td", {}, age(deploy.finishedAt ?? deploy.startedAt)),
              el("td", { class: "id" }, deploy.commit.slice(0, 7)),
              el("td", {}, deploy.author),
              el("td", {}, deploy.message, deploy.error ? el("div", { class: "error" }, deploy.error) : null),
            ),
          ),
        ),
      ),
    );
  } catch (error) {
    root.replaceChildren(el("p", { class: "empty" }, error.message));
  }
}

const statusClass = (status) => ({ live: "ok", failed: "bad", "rolled-back": "warn" })[status] ?? "";

async function loadLogs() {
  const { project, stage } = state.selected;
  const pre = $("#logs");
  pre.textContent = "Loading…";
  try {
    const events = await api("logs", { project, stage, since: $("#since").value, grep: $("#grep").value, limit: 1000 });
    pre.replaceChildren();
    if (!events.length) pre.textContent = "No log lines in this window.";
    for (const event of events) {
      const line = el("div", { class: /error|exception|timed out/i.test(event.message) ? "err" : "" });
      line.append(el("span", { class: "ts" }, `${new Date(event.timestamp).toISOString()} `), event.message);
      pre.append(line);
    }
    pre.scrollTop = pre.scrollHeight;
  } catch (error) {
    pre.textContent = error.message;
  }
}

async function refresh() {
  if (!state.token) return message("Enter the dashboard token to load projects", 8000);
  try {
    renderProjects(await api("overview"));
    $("#updated").textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    message(error.message, 8000);
  }
}

$("#token").value = state.token;
$("#token").addEventListener("change", (event) => {
  state.token = event.target.value.trim();
  localStorage.setItem(TOKEN_KEY, state.token);
  refresh();
});
$("#refresh").addEventListener("click", refresh);
$("#close").addEventListener("click", () => {
  $("#detail").hidden = true;
  $("main").classList.remove("with-detail");
  state.selected = null;
});
for (const button of document.querySelectorAll("[data-view]"))
  button.addEventListener("click", () => state.selected && select(state.selected, button.dataset.view));
$("#load-logs").addEventListener("click", loadLogs);
$("#grep").addEventListener("keydown", (event) => event.key === "Enter" && loadLogs());

refresh();
setInterval(refresh, REFRESH_MS);
