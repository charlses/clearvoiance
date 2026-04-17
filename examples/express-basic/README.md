# example: express-basic

Smallest possible Express app wired up to capture its traffic with
`@clearvoiance/node`. Used for dev smoke-testing and the CI e2e job.

## Run

1. Have the engine running (with or without ClickHouse). From the repo root:

   ```sh
   # ephemeral mode (no persistence)
   go build -o bin/clearvoiance ./engine/cmd/clearvoiance
   ./bin/clearvoiance serve
   ```

2. Start the example:

   ```sh
   pnpm --filter @clearvoiance/example-express-basic dev
   ```

3. Hit it:

   ```sh
   curl http://127.0.0.1:4000/health
   curl http://127.0.0.1:4000/users/42
   curl -X POST http://127.0.0.1:4000/echo \
     -H 'content-type: application/json' \
     -d '{"hello":"world"}'
   ```

4. Ctrl-C the example to close the session cleanly. Watch the engine log —
   each request appears as an `http` event.

## With ClickHouse persistence

```sh
docker run -d --rm --name ch \
  -p 18123:8123 -p 19000:9000 \
  -e CLICKHOUSE_USER=default -e CLICKHOUSE_PASSWORD=dev \
  -e CLICKHOUSE_DB=clearvoiance \
  clickhouse/clickhouse-server:24-alpine

./bin/clearvoiance serve \
  --clickhouse-dsn clickhouse://default:dev@127.0.0.1:19000/clearvoiance

# In another terminal, start the example, hit some endpoints, then:
curl -s --get http://127.0.0.1:18123 -u default:dev \
  --data-urlencode 'database=clearvoiance' \
  --data-urlencode 'query=SELECT id, http_method, http_path, http_status, http_route
                          FROM events ORDER BY timestamp_ns FORMAT TSV'
```
