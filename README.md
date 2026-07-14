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
    "apps": [
      { "name": "backend", "port": 10000, "color": "blue" },
      { "name": "frontend", "port": 3000, "color": "magenta", "open": true }
    ]
  }
}
```

Each app runs `bun --filter <name> dev` by default. Override with:

| field     | meaning                                                            |
| --------- | ----------------------------------------------------------------- |
| `name`    | display label + default `bun --filter` target                     |
| `filter`  | explicit `bun --filter <target>` (defaults to `name`)             |
| `cwd`     | run `bun --cwd <cwd> run <script>` instead of `--filter`          |
| `script`  | script to run in the workspace (default `dev`)                    |
| `command` | raw shell command, overrides the above (e.g. `vite dev`)          |
| `port`    | freed on start and shown in the URL banner                        |
| `color`   | prefix color (blue, magenta, green, yellow, cyan, red)            |
| `open`    | with `--open`, open this app's URL when its port comes up         |

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
  "apps": [ /* ... */ ],
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
- `devkit secrets push|pull [root]` — sync the encrypted secrets.
- `free-port <port>` — kill whatever is listening on a port (handy in a `predev`).
