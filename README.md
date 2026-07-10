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

## Bins

- `devkit [root] [--open] [--dry] [--version]` — the orchestrator above. `root` is an optional path to the folder holding the `devkit` config (defaults to the current directory); `--dry` prints the resolved commands and URLs without running anything.
- `free-port <port>` — kill whatever is listening on a port (handy in a `predev`).
