import { $ } from "bun";
import { log } from "./aws.ts";

/**
 * GitHub Deployments: the repo page and each commit show what is live where. Best effort — a
 * deploy never fails because GitHub was unreachable.
 */
const API = "https://api.github.com";

interface Context {
  repo: string;
  token: string;
}

async function context(): Promise<Context | undefined> {
  const repo = process.env.GITHUB_REPOSITORY ?? (await repoFromRemote());
  if (!repo) return undefined;
  const token = process.env.GITHUB_TOKEN ?? (await $`gh auth token`.quiet().nothrow().text()).trim();
  return token ? { repo, token } : undefined;
}

async function repoFromRemote() {
  const remote = (await $`git remote get-url origin`.quiet().nothrow().text()).trim();
  const match = /github\.com[:/]([^/]+\/[^/.]+)/.exec(remote);
  return match?.[1];
}

async function call<T>(ctx: Context, method: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ctx.token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "devkit-cloud",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

export interface GithubDeployment {
  succeed(url: string): Promise<void>;
  fail(): Promise<void>;
}

/** Opens a deployment for `sha` on `environment`; the result reports how it ended. */
export async function startGithubDeployment(
  sha: string,
  environment: string,
  description: string,
): Promise<GithubDeployment> {
  const quiet: GithubDeployment = { succeed: async () => undefined, fail: async () => undefined };
  const ctx = await context();
  if (!ctx) return quiet;
  try {
    const created = await call<{ id: number }>(ctx, "POST", `/repos/${ctx.repo}/deployments`, {
      ref: sha,
      environment,
      description,
      auto_merge: false,
      required_contexts: [],
      production_environment: environment === "production",
      transient_environment: false,
    });
    const status = async (state: "success" | "failure", environment_url?: string) => {
      try {
        await call(ctx, "POST", `/repos/${ctx.repo}/deployments/${created.id}/statuses`, {
          state,
          environment_url,
          log_url: process.env.GITHUB_SERVER_URL
            ? `${process.env.GITHUB_SERVER_URL}/${ctx.repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
            : undefined,
        });
      } catch (error) {
        log(`  GitHub deployment status not posted: ${error instanceof Error ? error.message : error}`);
      }
    };
    return { succeed: (url) => status("success", url), fail: () => status("failure") };
  } catch (error) {
    log(`  GitHub deployment not recorded: ${error instanceof Error ? error.message : error}`);
    return quiet;
  }
}
