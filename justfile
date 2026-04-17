# clearvoiance task runner
# Run `just` with no args to list available commands.

# Default: show available commands
default:
    @just --list

# ----- setup -----

# Install all dependencies and generate code. Run once after cloning.
bootstrap:
    pnpm install --frozen-lockfile
    go work sync
    just proto

# Regenerate protobuf bindings for Go + TypeScript.
proto:
    cd proto && buf generate

# ----- engine (Go) -----

engine-build:
    go build -o bin/clearvoiance ./engine/cmd/clearvoiance

engine-test:
    go test ./engine/...

engine-test-integration:
    go test -tags=integration ./engine/...

engine-dev:
    cd engine && air -c .air.toml

# ----- db-observer (Go) -----

observer-build:
    go build -o bin/clearvoiance-observer ./db-observer/cmd/clearvoiance-observer

observer-test:
    go test ./db-observer/...

# ----- sdk-node (TypeScript) -----

sdk-build:
    pnpm --filter @clearvoiance/node build

sdk-test:
    pnpm --filter @clearvoiance/node test

sdk-dev:
    pnpm --filter @clearvoiance/node dev

# ----- ui (Next.js) -----

ui-dev:
    pnpm --filter @clearvoiance/ui dev

ui-build:
    pnpm --filter @clearvoiance/ui build

ui-test:
    pnpm --filter @clearvoiance/ui test

# ----- linting / formatting -----

lint:
    golangci-lint run ./...
    pnpm lint

fmt:
    gofmt -w .
    goimports -w -local github.com/charlses/clearvoiance .
    pnpm format

typecheck:
    pnpm typecheck

# ----- testing -----

test: engine-test observer-test sdk-test ui-test

test-integration: engine-test-integration

ci-local: fmt lint typecheck test

# ----- docker / deployment -----

up:
    docker compose -f deploy/docker-compose.yml up -d

down:
    docker compose -f deploy/docker-compose.yml down

logs:
    docker compose -f deploy/docker-compose.yml logs -f

# ----- cleanup -----

clean:
    rm -rf bin/ sdk-node/dist/ ui/.next/ ui/out/
    find . -type d -name 'node_modules' -prune -exec rm -rf {} +

clean-generated:
    rm -rf sdk-node/src/generated/ engine/internal/pb/
