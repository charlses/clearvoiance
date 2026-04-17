# example: socketio-basic

Smallest possible Socket.io server wired up with `@clearvoiance/node` capture.
Used for dev smoke testing and the CI e2e-socketio job.

## Run

1. Have the engine running (with or without ClickHouse):

   ```sh
   go build -o bin/clearvoiance ./engine/cmd/clearvoiance
   ./bin/clearvoiance serve
   ```

2. Start the example:

   ```sh
   pnpm --filter @clearvoiance/example-socketio-basic dev
   ```

3. In another terminal, run the smoke client:

   ```sh
   pnpm --filter @clearvoiance/example-socketio-basic smoke:client
   ```

   It connects to the default namespace + `/chat`, exercises ping/pong,
   broadcast/fanout, and say/echo, then disconnects.

4. Ctrl-C the example to close the session cleanly. Each Socket.io event
   (connect, emit, recv, disconnect) appears as a row with
   `adapter = 'socket.io'`.

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

Then query after running the smoke:

```sh
curl -s --get http://127.0.0.1:18123 -u default:dev \
  --data-urlencode 'database=clearvoiance' \
  --data-urlencode "query=SELECT socket_op, socket_event, socket_id, \
                          socket_id IN (SELECT socket_id FROM events \
                                        WHERE socket_op = 'SOCKET_OP_CONNECT') as tracked \
                          FROM events WHERE adapter = 'socket.io' \
                          ORDER BY timestamp_ns FORMAT TSV"
```
