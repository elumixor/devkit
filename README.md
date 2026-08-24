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

`devkit dev` frees the ports, prints the local URLs, runs everything side by side with coloured
prefixes, and (with `--open`) opens the browser once the server is live. A platform is either one
process or a `processes` map — a web platform is a client and an API, and neither is worth naming as
a platform of its own.

| field       | meaning                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| `processes` | several processes under this platform, keyed by name                          |
| `filter`    | explicit `bun --filter <target>` (defaults to the process key)                 |
| `cwd`       | run `bun run --cwd <cwd> <script>` instead of `--filter`                       |
| `script`    | script to run in the workspace (default `dev`)                                 |
| `command`   | raw shell command, overrides the above (e.g. `vite dev`)                       |
| `type`      | a built-in dev target — see below                                             |
| `port`      | freed on start and shown in the URL banner                                     |
| `needs`     | platforms that must be running too                                            |
| `color`     | prefix colour; one is picked for you otherwise                                 |
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

**`tauri-macos`** builds, signs and notarizes the macOS app if this machine has a Developer ID
certificate, stages the DMG and a manifest for the web deploy to hand out, and refreshes the local
install if there is one. Options: `frontendDir`, `stageDir`, `installIfPresent`, and the App Store
Connect key env var names.

**`fastlane-ios`** builds the web bundle against the deployed API, syncs it into the Xcode project
and hands the archive to fastlane, which signs the app, the watch app and the widget and uploads to
TestFlight. Options: `frontendDir`, `iosDir`, `lane`, `defaultApiBaseUrl`, `apiBaseUrlEnv`, and the
key env var names.

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
