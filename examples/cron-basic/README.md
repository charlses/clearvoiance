# example: cron-basic

Smallest possible `node-cron` worker wired up with `@clearvoiance/node` capture.
Used for dev smoke testing and the CI e2e-cron job.

## Run

1. Engine:

   ```sh
   go build -o bin/clearvoiance ./engine/cmd/clearvoiance
   ./bin/clearvoiance serve
   ```

2. Example:

   ```sh
   pnpm --filter @clearvoiance/example-cron-basic dev
   ```

Two jobs run:

- `heartbeat` every second (always succeeds)
- `flaky` every 2 seconds (throws on every 3rd invocation)

Ctrl-C to stop. Each invocation appears as a row with `adapter = 'cron.node-cron'`,
with the failed `flaky` runs having `cron_status = 'error'`.

## With ClickHouse persistence

```sh
docker run -d --rm --name ch \
  -p 18123:8123 -p 19000:9000 \
  -e CLICKHOUSE_USER=default -e CLICKHOUSE_PASSWORD=dev \
  -e CLICKHOUSE_DB=clearvoiance \
  clickhouse/clickhouse-server:24-alpine

./bin/clearvoiance serve \
  --clickhouse-dsn clickhouse://default:dev@127.0.0.1:19000/clearvoiance
```

Query after a run:

```sh
curl -s --get http://127.0.0.1:18123 -u default:dev \
  --data-urlencode 'database=clearvoiance' \
  --data-urlencode 'query=SELECT cron_job, cron_status, count(), avg(duration_ns) / 1e6 AS avg_ms
                          FROM events WHERE adapter = '\''cron.node-cron'\''
                          GROUP BY cron_job, cron_status
                          ORDER BY cron_job, cron_status FORMAT PrettyCompact'
```
