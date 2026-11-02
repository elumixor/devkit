# hello

The project Devkit Cloud is tested against: a static page, a Nitro API, blob storage, work after
the response, a 90-second stream and a cron, deployed to `hello.dk.atmagaming.com`.

```bash
bun link                  # once, in the devkit root: the example uses this checkout's devkit
bun install
bun run deploy            # main → production, develop → development
```

| route              | what it proves                                                  |
| ------------------ | --------------------------------------------------------------- |
| `/`                | static files from S3 through the edge                           |
| `GET /api/hello`   | the function sees the stage's env (`HELLO_MESSAGE`) and hostname |
| `POST /api/upload` | a 1 MB body into blob storage                                   |
| `GET /api/slow`    | answers at once, writes `slow/last.txt` from `waitUntil`        |
| `GET /api/sse`     | streams one event a second for 90 s                             |
| `GET /api/cron/tick` | called every five minutes, writes `cron/last.txt`             |
| `GET /api/blobs`   | lists what the above stored                                     |
