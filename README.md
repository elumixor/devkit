# @elumixor/devkit

Dev orchestrator for bun monorepos. One config, and `bun run dev` frees the ports, runs every app side-by-side with colored prefixes, prints the local URLs, and (with `--open`) opens the browser once the server is live.

## Install

```bash
bun add -d @elumixor/devkit
```

## Configure

Add a `devkit` block to your root `package.json`:

```jsonc
{
  "scripts": {
    "dev": "devkit",
    "dev:open": "devkit --open"
  },
  "devkit": {
    "apps": {
      "backend": { "port": 10000 },
      "frontend": { "port": 3000, "open": true }
    }
  }
}
```

Each app is keyed by its name, and runs `bun --filter <name> dev` by default. Override with:

| field     | meaning                                                            |
| --------- | ----------------------------------------------------------------- |
| `filter`  | explicit `bun --filter <target>` (defaults to the name)           |
| `cwd`     | run `bun --cwd <cwd> run <script>` instead of `--filter`          |
| `script`  | script to run in the workspace (default `dev`)                    |
| `command` | raw shell command, overrides the above (e.g. `vite dev`)          |
| `port`    | freed on start and shown in the URL banner                        |
| `color`   | prefix color (blue, magenta, green, yellow, cyan, red); one is picked for you otherwise |
| `open`    | with `--open`, open this app's URL when its port comes up         |

## Deploy

`devkit deploy` runs the release steps of a repo the same way `devkit` runs its dev processes:
side by side, with one line each.

```jsonc
{
  "scripts": { "deploy": "devkit deploy" },
  "devkit": {
    "deploy": {
      "desktop": { "command": "bun scripts/deploy-desktop.ts" },
      "vercel": { "command": "bun scripts/deploy-vercel.ts", "needs": ["desktop"] },
      "ios": { "command": "bun scripts/deploy-ios.ts" }
    }
  }
}
```

```bash
bun run deploy            # every target
bun run deploy ios        # one target, plus whatever it needs
devkit deploy --dry       # print the plan
devkit deploy --verbose   # stream every line instead of the live board
```

Targets with no `needs` start together; one with `needs` waits for those, so a build that another
target packages up can run first without serialising the whole release.

Each target shows a spinner, how long it has been running and the last line it printed. The full
output goes to `.devkit/deploy/<name>.log`, and the tail of whichever target failed is printed at
the end — a release prints tens of thousands of lines, and interleaving all of them is unreadable.
Piped output (CI, a log file) gets prefixed streaming lines instead of the board.

Each target is keyed by its name — that is what the board shows, what `needs` points at, and what
you type on the command line.

| field     | meaning                                            |
| --------- | -------------------------------------------------- |
| `command` | shell command that performs this deploy             |
| `needs`   | targets that must finish first                      |
| `color`   | colour of this target's line; one is picked for you otherwise |

## Build

`devkit build` packs a client-rendered web app and a Nitro API into one Vercel deployment: the app
as static files, the API as the one serverless function behind them. Same origin, so the web client
calls the API without CORS.

```jsonc
"devkit": {
  "build": {
    "frontendDir": "apps/frontend",
    "backendDir": "apps/backend",
    "apiPrefixes": ["mobile", "health"],
    "clientCommand": "bunx nitro-client",
    "include": { "dist/download": "download" }
  }
}
```

| key             | meaning                                                                        |
| --------------- | ------------------------------------------------------------------------------ |
| `frontendDir`   | web app dir, run with `bun run build` (default `apps/frontend`)                 |
| `backendDir`    | Nitro dir (default `apps/backend`)                                              |
| `webBuildDir`   | where the web build lands inside `frontendDir` (default `build`)                |
| `apiPrefixes`   | paths the API owns; every other path answers with the app shell                 |
| `clientCommand` | run in `backendDir` first, unless `SKIP_CLIENT_GEN` is set                      |
| `include`       | staged dirs to serve alongside the web files, as `{ "<source>": "<url path>" }` |

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

## Simulator

`devkit sim` builds an Apple target and launches it on a simulator without opening Xcode. A watch
app has no sign-in of its own, so `previewEnv` is what lets it run on a simulator with no paired
phone; `--real` leaves it unset and talks to the real API.

```jsonc
"devkit": {
  "sim": {
    "project": "apps/frontend/ios/App/App.xcodeproj",
    "scheme": "BalanceWatch",
    "bundleId": "com.example.app.watchkitapp",
    "device": "Apple Watch Series 11 (46mm)",
    "previewEnv": "BALANCE_WATCH_PREVIEW"
  }
}
```

`--device`, or `DEVKIT_SIM_DEVICE`, overrides the configured simulator — everyone's list of
installed ones differs. `sdk` (default `watchsimulator`) and `derivedDataDir` (default `build/sim`)
are there for a phone target.

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
  "apps": { /* ... */ },
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

- `devkit [root] [--open] [--dry] [--version]` — the orchestrator above. `root` is an optional path to the folder holding the `devkit` config (defaults to the current directory); `--dry` prints the resolved commands and URLs without running anything.
- `devkit clone <owner/repo> [dir]` — clone, decrypt secrets, run setup.
- `devkit setup [root] [--dry]` — validate secrets, install, `terraform init`, run steps.
- `devkit deploy [targets...] [--dry] [--verbose]` — run the release targets, in parallel.
- `devkit build` — build the web app and the API into one Vercel output.
- `devkit sim [--real] [--device <name>]` — build and launch the app on a simulator.
- `devkit version` — write the source version into every file that declares one.
- `devkit release <prefix>` — tag this commit `<prefix>-v<timestamp>` and push it.
- `devkit secrets push|pull [root]` — sync the encrypted secrets.
- `free-port <port>` — kill whatever is listening on a port (handy in a `predev`).
