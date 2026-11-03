# @elumixor/devkit

Dev orchestrator for bun monorepos. One config lists the platforms a product ships on — a web app, a
Mac shell, an iPhone app, a watch app — and three commands do the three things anyone ever does with
them:

```bash
devkit dev            # run every platform side by side
devkit build          # build every platform, in parallel
devkit deploy         # ship every platform, in dependency order
```

Every one of them takes a platform: `devkit dev:iphone`, `devkit build:mac`, `devkit deploy:web`.
So does a positional, for a shell that completes them: `devkit build mac iwatch`.

## Install

```bash
bun add -d @elumixor/devkit
```

`devkit update` moves the global `devkit` and, run inside a project, its dependency to the newest
published version (`--dry` prints what would change).

## Configure

Add a `devkit` block to your root `package.json`. Three phases, each a map of platform name to one
step, and a platform means the same thing in all three:

```jsonc
{
  "scripts": {
    "dev": "devkit dev",
    "build": "devkit build",
    "deploy": "devkit deploy"
  },
  "devkit": {
    "generate": { "command": "bunx nitro-client", "cwd": "apps/backend" },
    "dev": {
      "web": {
        "processes": {
          "backend": { "filter": "@app/backend", "port": 3100 },
          "frontend": { "port": 8081, "open": true }
        }
      },
      "mac": { "command": "bunx tauri dev", "cwd": "apps/frontend", "needs": ["web"] }
    },
    "build": {
      "web": { "type": "web", "options": { "apiPrefixes": ["api"] } },
      "mac": { "type": "tauri-macos" }
    },
    "deploy": {
      "mac": { "type": "tauri-macos" },
      "web": { "type": "vercel", "needs": ["mac"] }
    }
  }
}
```

`needs` is what makes one command enough. Naming a platform also runs the platforms it depends on —
`devkit dev:mac` starts the web stack the Mac window points at, `devkit deploy:web` builds the
installer the site hands out first. Steps with no `needs` all start at once.

`generate` runs once before a build or a deploy graph, ahead of everything running in parallel. It
is for sources every platform's compile reads — a typed API client generated from the routes — which
must not be written by one build while another is reading them. It sets `SKIP_CLIENT_GEN=1` for the
steps it runs before.

## Dev

`devkit dev` frees the ports and runs everything side by side. A platform is either one process or a
`processes` map — a web platform is a client and an API, and neither is worth naming as a platform of
its own.

On a terminal it draws a board: every process's URL and state (starting, ready in 1.2s, crashed) pinned
at the top, the merged log below.

```
 devkit dev · budget                                              logs in .devkit/dev
 ● 1 web:backend   http://localhost:3107   ready in 2.4s
 ● 2 web:frontend  http://localhost:8087   ready in 2.1s
── all ─────────────────────────────────────────────────────────────────────────────
web:frontend │   VITE v8.3.0  ready in 1055 ms
web:backend  │ [nitro] ✔ Nitro Server built in 521ms
 1-2 focus  a all  o open  r restart  c clear  jk ud gg G scroll  v select  y copy  e errors  q quit
```

The log scrolls like `less`: `j`/`k` or arrows by a line, `u`/`d` by half a screen, PgUp/PgDn by a
screen, `gg` to the top and `G` back to following. `v` (or `V`) starts a line selection at the bottom
row; move it with the same keys and `y` copies it to the clipboard, `y` alone copies what is on screen.
Dragging with the mouse selects too, scrolling on its own while the pointer is above or below the log,
and copies on release; the wheel scrolls. Hold Option (macOS) or Shift for the terminal's own selection.

A printed error with a stack folds into one red summary row (its message, plus a database `detail`
when there is one). Click `[copy]` to copy the whole error, or the `[▸ N lines]` button to expand it;
`e` expands or folds every error.

A crashed process stays on the board until you restart it with `r`; the rest keep running. Anywhere
else (an agent's shell, CI, a pipe, or `--plain`) it prints prefixed lines instead: the URLs first,
then a `devkit` line for every ready, crash and exit, and one `all ready:` line listing every URL.
Either way, each process's full output is in `.devkit/dev/<name>.log`. With `--open`, every `open`
process's URL opens once its port answers.

| field       | meaning                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| `processes` | several processes under this platform, keyed by name                          |
| `filter`    | explicit `bun --filter <target>` (defaults to the process key)                 |
| `cwd`       | run `bun run --cwd <cwd> <script>` instead of `--filter`                       |
| `script`    | script to run in the workspace (default `dev`)                                 |
| `command`   | raw shell command, overrides the above (e.g. `vite dev`)                       |
| `type`      | a built-in dev target — see below                                             |
| `port`      | freed on start, shown on the board, and polled to tell when it is ready        |
| `needs`     | platforms that must be running too                                            |
| `color`     | label colour; one is picked for you otherwise                                  |
| `open`      | with `--open`, open this process's URL when its port comes up                  |

### Built-in dev targets

**`capacitor-ios`** runs the iPhone app on a simulator against the running dev server. The webview
loads the page over the network rather than from the bundle, so every web edit is live the moment
Vite has it. Native edits still need a compile — that is what `watch` is for.

```jsonc
"iphone": {
  "type": "capacitor-ios",
  "needs": ["web"],
  "options": {
    "project": "apps/frontend/ios/App/App.xcodeproj",
    "scheme": "App",
    "bundleId": "com.example.app",
    "device": "iPhone 17 Pro",
    "port": 8081,
    "watch": ["apps/frontend/ios/App/App"]
  }
}
```

**`xcode-sim`** builds any Apple scheme and launches it on a simulator without opening Xcode. A
watch app has no sign-in of its own, so `previewEnv` is what lets it run on a simulator with no
paired phone; `--real` leaves it unset and talks to the real API.

```jsonc
"iwatch": {
  "type": "xcode-sim",
  "options": {
    "project": "apps/frontend/ios/App/App.xcodeproj",
    "scheme": "BalanceWatch",
    "sdk": "watchsimulator",
    "bundleId": "com.example.app.watchkitapp",
    "device": "Apple Watch Series 11 (46mm)",
    "previewEnv": "APP_WATCH_PREVIEW",
    "watch": ["apps/frontend/ios/App/WatchApp"]
  }
}
```

`--device`, or `DEVKIT_SIM_DEVICE`, overrides the configured simulator — everyone's list of
installed ones differs. Saving a watched source rebuilds and relaunches; Swift has no hot reload, so
this is what "live" means on the native side.

## Build and deploy

Both draw the same board: one line per platform, with a spinner, how long it has been running and
the last line it printed. The full output goes to `.devkit/<phase>/<platform>.log`, and the tail of
whichever platform failed is printed at the end — a release prints tens of thousands of lines, and
interleaving all of them is unreadable. Piped output (CI, a log file) gets prefixed streaming lines
instead.

```bash
devkit build              # every platform
devkit build:iphone       # one platform, plus whatever it needs
devkit deploy --dry       # print the plan
devkit deploy --verbose   # stream every line instead of the live board
```

| field     | meaning                                                       |
| --------- | ------------------------------------------------------------- |
| `command` | shell command that performs this step                          |
| `type`    | a built-in target instead, configured by `options`             |
| `needs`   | platforms that must finish first                               |
| `color`   | colour of this platform's line; one is picked for you otherwise |

Each native shell carries its own copy of the web app, built with its own API base URL, and
`devkit build` runs those builds beside each other — so each is given its own `BUILD_DIR`,
`KIT_DIR` and `VITE_CACHE_DIR` rather than overwriting the others' files halfway through.

### Built-in build targets

**`web`** packs a client-rendered web app and a Nitro API into one Vercel deployment: the app as
static files, the API as the one serverless function behind them. Same origin, so the web client
calls the API without CORS.

| option        | meaning                                                                        |
| ------------- | ------------------------------------------------------------------------------ |
| `frontendDir` | web app dir, run with `bun run build` (default `apps/frontend`)                 |
| `backendDir`  | Nitro dir (default `apps/backend`)                                             |
| `webBuildDir` | where the web build lands inside `frontendDir` (default `build`)               |
| `apiPrefixes` | paths the API owns; every other path answers with the app shell                 |
| `include`     | staged dirs to serve alongside the web files, as `{ "<source>": "<url path>" }` |

**`tauri-macos`** builds the macOS app and nothing else — no Developer ID, no notarization, no
install. It answers "does the Mac shell still compile against this frontend"; shipping is the deploy
target of the same name. Options: `frontendDir`, `bundles` (default `app`), `webSuffix`.

**`capacitor-ios`** builds the web bundle, syncs it into the Xcode project and compiles the iOS app
for a simulator — the whole chain a TestFlight release goes through, minus the signing and the
upload. Options: `frontendDir`, `iosDir`, `webSuffix`, plus `project`, `scheme`, `configuration`,
`sdk`, `derivedDataDir`.

**`xcode`** compiles one scheme for a simulator: a watch app, a widget, anything native that carries
no web bundle of its own. Options: `project`, `scheme`, `configuration`, `sdk`, `derivedDataDir`.

Simulator builds are compiled with signing off, so a machine that has never seen the team's
provisioning profiles can still tell you whether the app compiles.

### Built-in deploy targets

**`vercel`** builds here and uploads the finished output, rather than handing Vercel the repo and
waiting for it to build the same thing again. Options: `cwd`.

**`aws`** is Devkit Cloud: the same web build, served from our own AWS account instead of Vercel.
The static files go to S3, the Nitro API to one Lambda function behind a shared CloudFront
distribution, and the stage is live at `<project>.devkit.atmagaming.com` (or `<project>-dev.…` for
`development`). See [Devkit Cloud](#devkit-cloud).

**`tauri-macos`** builds, signs and notarizes the macOS app if this machine has a Developer ID
certificate, stages the DMG and a manifest for the web deploy to hand out, and refreshes the local
install if there is one. Options: `frontendDir`, `stageDir`, `installIfPresent`, and the App Store
Connect key env var names.

**`fastlane-ios`** builds the web bundle against the deployed API, syncs it into the Xcode project
and hands the archive to fastlane, which signs the app, the watch app and the widget and uploads to
TestFlight. Options: `frontendDir`, `iosDir`, `lane`, `defaultApiBaseUrl`, `apiBaseUrlEnv`, and the
key env var names.

## Devkit Cloud

Our Vercel replacement: a deploy target plus a handful of AWS services, with nothing running
between requests. One CloudFront distribution serves every project; a CloudFront Function reads
the hostname's route record from a KeyValueStore and sends the request to the project's Lambda
Function URL for API paths, or to that deploy's prefix in S3 for everything else. Every deploy is
immutable — its own S3 prefix and Lambda version — so a rollback is two writes.

```jsonc
"deploy": {
  "web": {
    "type": "aws",
    "options": {
      "project": "kenoverse",              // default: the repo name
      "apiPrefixes": ["api"],
      "routing": "spa",                    // spa | pages | ssr
      "memory": 512, "timeout": 120,        // MB, seconds
      "crons": [{ "path": "/api/cron/sync", "schedule": "*/5 * * * *" }],
      "domains": { "production": ["kenoverse.app"], "development": [] },
      "predeploy": "bun run db:migrate"
    }
  }
}
```

`headers` sets response headers by path, as `vercel.json` does, and takes a `vercel.json` block
pasted as is (`[{ "key", "value" }]`) or a plain map. `source` is Vercel's syntax: `:name` is one
segment, `:name*` any depth, `( )` a raw regex. The router adds them on the way out, cache hits
included, so they change with the deploy and roll back with it. They apply to 2xx and 3xx
responses only (CloudFront runs no function on an origin error), and compile to 1 KB at most.

```jsonc
"headers": [
  { "source": "/bar.js", "headers": { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" } },
  { "source": "/icons/(.*)", "headers": { "Access-Control-Allow-Origin": "*" } }
]
```

`"apiPrefixes": []` makes a static site: no Nitro build, no function, role, schedules or health
check, only the files. A frontend with no `build` script is served as it is, so a folder of
hand-written files is `"frontendDir": ".", "webBuildDir": "public"`.

A `domains` entry starting with `*.` (say `*.desk.atmagaming.com`) only adds a wildcard alias to the
distribution: every hostname under it then rides one certificate name, which keeps the shared
certificate under ACM's per-certificate name quota. List it next to the hosts it covers.

A domain whose DNS isn't on Cloudflare still works: the deploy prints the certificate's validation
CNAME and the record to point at the distribution, waits for the validation, and serves the host once
its DNS points there. Crons call their path with `Authorization: Bearer $CRON_SECRET`, made on the
first deploy.

`devkit deploy` builds, then: reconciles the function, role, log group, URL, schedules and domains;
uploads the static files (unchanged files are copied server-side); publishes a new function
version; runs `predeploy` with the stage's env; invokes the new version's `/api/health`; and only
then moves the `live` alias and the route records. A failed health check leaves the old deploy
serving. `main` deploys `production`, `develop` deploys `development`; `--stage` picks by hand.

```bash
devkit cloud bootstrap            # once per account: buckets, edge, roles, budgets ($5 and $20)
devkit cloud init                 # once per repo: the aws target and .github/workflows/deploy.yml
devkit cloud env push             # the root .env into the stage (SSM Parameter Store)
devkit cloud status               # what is live, with calls, errors and p95 for the last 24 h
devkit cloud logs --follow        # CloudWatch logs for the stage
devkit cloud deploys <project>    # the last ten deploys
devkit cloud rollback <project>   # back to the previous deploy, in seconds
devkit cloud infra apply          # Terraform in infra/, mapped outputs into each stage's env
devkit cloud domains add <project> <host>   # cert, alias, Cloudflare DNS, route; later deploys keep it
devkit cloud destroy <project> --stage development
```

Databases and anything else the platform doesn't make itself stay declared in Terraform. Point the
target at the module and name which outputs become which env vars per stage:

```json
"terraform": {
  "dir": "infra",
  "env": {
    "production": { "DATABASE_URL": "production_database_url" },
    "development": { "DATABASE_URL": "develop_database_url" }
  }
}
```

`devkit cloud infra plan` shows the changes, `apply` makes them and copies the outputs into SSM,
`sync` only copies. The next deploy reads them like any other env var; CI needs no Terraform
credentials. Resources the function itself must call (a queue, a table) also need `permissions`.

Env vars live in SSM at `/dk/<project>/<stage>/<KEY>` and are copied into the function at deploy,
and into the build's environment, so `VITE_*` values reach the frontend in CI too. In the function,
`import { waitUntil } from "@elumixor/devkit/runtime"` keeps the invocation alive after the response
(it delegates to Vercel's `waitUntil` when the code still runs there), and
`import { put, list, del, head, createUploadUrl } from "@elumixor/devkit/blob"` covers what we used
of `@vercel/blob`: public blobs are served at `https://<host>/_blob/<path>`.

CI assumes the `dk-deploy` role through GitHub's OIDC provider, so no AWS keys are stored anywhere.
`bootstrap` also writes a scoped `devkit` AWS profile for deploying from a laptop. `examples/hello`
exercises every feature and is what `.github/workflows/deploy-cloud.yml` deploys.

### Dashboard and MCP

[devkit.atmagaming.com](https://devkit.atmagaming.com) ([elumixor/desk-devkit](https://github.com/elumixor/desk-devkit),
a SvelteKit app in the desk suite's style) shows every project and
stage, what is live, the last day's calls, errors and p95, the deploy history and the function
logs. It is itself a project on the platform; its function may read the deploy records, CloudWatch
metrics and `dk-*` log groups through the `permissions` option. Sign-in is the desk suite's Clerk
account: Clerk's Frontend API at clerk.desk.atmagaming.com is same-site with devkit.atmagaming.com,
so the session carries over without a satellite domain. The API accepts a session whose email is on
`DASHBOARD_EMAILS`, or `DASHBOARD_TOKEN` as a bearer for scripts. Read-only: deploys and rollbacks
stay with the CLI and MCP.

`devkit mcp` serves the same over the Model Context Protocol on stdio — `cloud_status`,
`cloud_deploys`, `cloud_logs`, `cloud_rollback`, `cloud_env` (keys only), `cloud_domains`,
`cloud_domain_add` and `cloud_domain_remove` — so
an agent can check and undo a deploy. Register it once:

```bash
claude mcp add --scope user devkit-cloud -- devkit mcp
```

`permissions` on the `aws` target appends IAM `Allow` statements to the function's role for apps
that read other AWS resources; everything else keeps the default role (its own logs and blob
prefix only).

## Versions

`devkit version` reads one version and writes it into every other file that declares one, so the
App Store, the installer and the number at the bottom of settings can't drift apart.

```jsonc
"devkit": {
  "version": {
    "source": "apps/frontend/src-tauri/tauri.conf.json",
    "packages": ["package.json", "apps/frontend/package.json"],
    "cargo": ["apps/frontend/src-tauri/Cargo.toml"],
    "xcodeProjects": ["apps/frontend/ios/App/App.xcodeproj/project.pbxproj"],
    "marketingVersionPlists": ["apps/frontend/ios/App/App/Info.plist"],
    "plists": ["apps/frontend/ios/App/WatchApp/Info.plist"]
  }
}
```

Targets in an Xcode project read `$(MARKETING_VERSION)` from the project, so their plists are
pointed at it rather than at a number — `plists` is for targets wired in by a script, which have no
such setting and carry the number themselves.

`devkit release <prefix>` tags the current commit `<prefix>-v<timestamp>` and pushes the tag, which
is how a CI release is asked for.

## Setting up a machine

A repo usually needs a couple of gitignored files before it will run — `.env`, `infra/terraform.tfvars` — and those cannot be fetched back from a host. Vercel, for one, stores Terraform-managed variables write-only and hands them back from `vercel env pull` as *empty strings*, which looks like it worked and quietly leaves you with a `.env` full of blanks.

So devkit syncs them itself, encrypted, in a private repo. On a new machine, the whole setup is:

```bash
gh auth login
devkit clone elumixor/puretype   # clone, decrypt secrets, install, terraform init
```

`clone` asks for your secrets passphrase the first time, then caches it — you won't be asked again on that machine.

Declare what to sync and what to run:

```jsonc
"devkit": {
  "setup": {
    "secrets": [".env", "infra/terraform.tfvars"],
    "env": [{ "file": ".env", "example": ".env.example" }],
    "terraform": "infra",
    "steps": ["bun --filter backend prisma:generate"]
  }
}
```

| key           | meaning                                                                              |
| ------------- | ------------------------------------------------------------------------------------ |
| `secrets`     | gitignored files to sync, encrypted, via `devkit secrets push` / `pull`               |
| `secretsRepo` | private repo holding them (default `elumixor/secrets`)                                |
| `env`         | env files to validate against a committed `.example` — missing *or empty* keys fail   |
| `terraform`   | directory to `terraform init`, skipped if it has no `terraform.tfvars`                |
| `install`     | run `bun install` (default true)                                                       |
| `steps`       | shell commands to run last, in order                                                   |

`setup` refuses to continue on a blank value. A missing secret that reads as `""` otherwise surfaces much later as an unrelated-looking bug.

### The passphrase

Each project's secrets are packed into one AES-256-GCM bundle (`<project>.enc`) in the secrets repo, encrypted with a key derived from a single passphrase via scrypt. Nothing else is needed to read them — no key file, no keychain, no external binary — so this works on any OS.

- First `secrets push` for a project asks for the passphrase twice, to catch a typo you could never recover from.
- It's then cached at `~/.config/devkit/passphrase` (mode 600), so you type it once per machine.
- `DEVKIT_PASSPHRASE` overrides both, for CI.
- Wrong passphrase fails loudly on GCM's auth tag; it can't silently produce garbage.

**Keep the passphrase in your password manager.** It is the only thing standing between a fresh laptop and your secrets, and the only thing that can't be recovered if lost.

Changed a `.env`? Run `devkit secrets push`, or the next machine gets a stale copy.

## Bins

- `devkit dev [platforms...] [--open] [--dry]` — run the dev processes. `devkit` on its own does the same.
- `devkit build [platforms...] [--dry] [--verbose]` — build the platforms, in parallel.
- `devkit deploy [platforms...] [--dry] [--verbose]` — ship the platforms, in dependency order.
- `devkit clone <owner/repo> [dir]` — clone, decrypt secrets, run setup.
- `devkit setup [root] [--dry]` — validate secrets, install, `terraform init`, run steps.
- `devkit version` — write the source version into every file that declares one.
- `devkit release <prefix>` — tag this commit `<prefix>-v<timestamp>` and push it.
- `devkit secrets push|pull [root]` — sync the encrypted secrets.
- `free-port <port>` — kill whatever is listening on a port (handy in a `predev`).

Any of `dev`, `build` and `deploy` also take a platform as a suffix — `devkit build:mac` — which is
what reads best in a `package.json` script.
