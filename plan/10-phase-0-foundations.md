# Phase 0 — Foundations

**Duration:** 2–3 days.
**Goal:** Empty repo → fully scaffolded monorepo with CI green on a trivial commit.

Phase 0 produces no user-facing functionality. It removes all "yak shaving" from every subsequent phase so that feature work can start immediately when Phase 1 begins.

## Deliverables

### 1. Repository scaffolding

Create the directory tree from [`05-repo-structure.md`](./05-repo-structure.md). Specifically:

- `engine/`, `db-observer/`, `sdk-node/`, `ui/`, `proto/`, `deploy/`, `examples/`, `docs/`, `scripts/`, `.github/`
- Top-level files: `README.md`, `LICENSE` (Apache-2.0), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.editorconfig`, `.gitignore`, `.gitattributes`, `justfile`, `go.work`, `pnpm-workspace.yaml`, `package.json` (root)

### 2. Go workspace + baseline engine module

- `go.work` at repo root referencing `engine/` and `db-observer/`.
- `engine/go.mod` with module path `github.com/<org>/clearvoiance/engine` and Go 1.22.
- `engine/cmd/clearvoiance/main.go` with a no-op CLI that prints `clearvoiance <version>` and exits.
- `engine/internal/telemetry/` with a `slog` setup.

### 3. Node workspace + baseline SDK package

- `pnpm-workspace.yaml` listing `sdk-node`, `ui`, `examples/*`.
- `sdk-node/package.json` with `name: @clearvoiance/node`, `version: 0.0.0-alpha.0`, `type: module`, ESM+CJS dual build via `tsup`.
- `sdk-node/src/index.ts` exporting a stub `createClient(config)` function that does nothing.
- `sdk-node/tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`.

### 4. Next.js UI skeleton

- `ui/` via `create-next-app` (App Router, TS, Tailwind, ESLint).
- Install shadcn: `pnpm dlx shadcn@latest init`.
- `ui/src/app/page.tsx` with "clearvoiance" placeholder.

### 5. Protobuf toolchain

- `proto/buf.yaml`, `proto/buf.gen.yaml`.
- `proto/clearvoiance/v1/event.proto` (contents from [`03-event-schema.md`](./03-event-schema.md)).
- `proto/clearvoiance/v1/capture.proto` (from [`04-protocol-spec.md`](./04-protocol-spec.md)).
- `scripts/generate-proto.sh` that runs `buf generate`.
- Generated code lands in `engine/internal/pb/` (committed) and `sdk-node/src/generated/` (gitignored, built in CI).

### 6. Task runner (`justfile`)

Must work on a fresh clone after `just bootstrap`:

```
just bootstrap          # pnpm install + go work sync + buf deps
just proto              # regenerate protobufs
just engine-build       # go build ./engine/cmd/clearvoiance
just engine-test        # go test ./engine/...
just engine-dev         # air (hot reload) on engine
just sdk-build          # tsup build
just sdk-test           # vitest run
just sdk-dev            # vitest watch
just ui-dev             # next dev
just ui-build
just lint               # golangci-lint + eslint
just fmt                # gofmt + prettier
```

### 7. CI (GitHub Actions)

`.github/workflows/ci.yml` running on every PR:

- `proto-check`: `buf lint` + `buf breaking --against .git#branch=main`
- `go-check`: `go build`, `go test`, `go vet`, `golangci-lint`
- `node-check`: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`
- `ui-check`: `pnpm --filter ui build`, `pnpm --filter ui lint`

All jobs must pass before merge. Branch protection rule enforced.

### 8. Licensing & contribution files

- `LICENSE` — Apache-2.0 full text.
- `CONTRIBUTING.md` — how to set up dev env, coding standards, PR process, DCO sign-off requirement.
- `SECURITY.md` — how to report vulnerabilities (private, email + GPG key).
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1.
- `.github/PULL_REQUEST_TEMPLATE.md` — checklist: tests added, docs updated, changeset added.
- `.github/ISSUE_TEMPLATE/bug_report.md` and `feature_request.md`.
- `.github/CODEOWNERS` — primary author on all paths initially.

### 9. Versioning + changelog infrastructure

- **Node:** `@changesets/cli` initialized. `CHANGELOG.md` per package.
- **Go:** `goreleaser` config at `.goreleaser.yaml` (builds amd64+arm64 Linux/macOS binaries, doesn't publish yet).
- Semantic versioning across all artifacts; start at `0.1.0` after Phase 1.

### 10. Pre-commit hooks

- `.husky/` with a `pre-commit` hook:
  - `lint-staged` for Node files (prettier, eslint --fix)
  - `gofmt` + `goimports` on Go files
  - `buf format` on proto files

### 11. Dev environment docs

`CONTRIBUTING.md` section "Setting up your dev environment":

- Required tools: Go 1.22+, Node 20+, pnpm 9+, Docker, `buf`, `just`, `air`, `mise` (recommended).
- `mise.toml` at repo root pinning all tool versions.
- One-command bootstrap: `git clone && cd clearvoiance && mise install && just bootstrap`.

### 12. Docker images (scaffolded, not functional)

`deploy/images/engine/Dockerfile` — multi-stage Go build producing a minimal image (`distroless/static` as base). Doesn't do anything useful yet but builds and runs.

## File checklist (Phase 0 deliverable)

Tick these off as you go:

```
[ ] /README.md
[ ] /LICENSE (Apache-2.0)
[ ] /CONTRIBUTING.md
[ ] /SECURITY.md
[ ] /CODE_OF_CONDUCT.md
[ ] /.editorconfig
[ ] /.gitignore
[ ] /.gitattributes
[ ] /justfile
[ ] /go.work
[ ] /pnpm-workspace.yaml
[ ] /package.json (root)
[ ] /mise.toml
[ ] /.github/workflows/ci.yml
[ ] /.github/workflows/proto-check.yml
[ ] /.github/CODEOWNERS
[ ] /.github/PULL_REQUEST_TEMPLATE.md
[ ] /.github/ISSUE_TEMPLATE/bug_report.md
[ ] /.github/ISSUE_TEMPLATE/feature_request.md
[ ] /.goreleaser.yaml
[ ] /.husky/pre-commit
[ ] /engine/go.mod
[ ] /engine/cmd/clearvoiance/main.go
[ ] /engine/internal/telemetry/logger.go
[ ] /db-observer/go.mod
[ ] /sdk-node/package.json
[ ] /sdk-node/tsconfig.json
[ ] /sdk-node/tsup.config.ts
[ ] /sdk-node/vitest.config.ts
[ ] /sdk-node/src/index.ts
[ ] /ui/ (next.js scaffold complete)
[ ] /proto/buf.yaml
[ ] /proto/buf.gen.yaml
[ ] /proto/clearvoiance/v1/event.proto
[ ] /proto/clearvoiance/v1/capture.proto
[ ] /scripts/generate-proto.sh
[ ] /deploy/images/engine/Dockerfile
```

## Acceptance criteria

Phase 0 is complete when, starting from a clean clone:

1. `mise install && just bootstrap` runs without errors.
2. `just proto` generates Go + TS bindings without errors.
3. `just engine-build` produces a runnable binary that prints version and exits 0.
4. `just engine-test` passes (no tests yet, exit 0).
5. `just sdk-test` passes.
6. `just sdk-build` emits ESM + CJS dist.
7. `just ui-dev` opens a placeholder page at localhost.
8. Pushing to a PR branch: CI runs all jobs green.
9. A deliberately-broken proto change makes `proto-check` fail (breaking change detection works).

## Non-goals

- No actual capture logic.
- No actual replay logic.
- No storage backends connected.
- No Docker Compose running the stack yet.
- No published packages (no npm publish, no GitHub Release).

## Open questions for this phase

- **GitHub org/user name for the repo?** Determines module paths. Decide before `go.mod` is written, or use `github.com/PLACEHOLDER/clearvoiance` and `sed` later.
- **Docs site tooling:** Mintlify vs. Docusaurus vs. Nextra. Can defer to Phase 8 but folder `docs/` is scaffolded.
- **Monorepo tool:** pnpm + just is current choice. Nx / Turborepo considered and rejected (overkill for 3 packages).

## Time budget

| Task | Estimate |
|---|---|
| Directory tree + boilerplate files | 2h |
| Go workspace + engine scaffold | 2h |
| Node workspace + SDK scaffold | 2h |
| Next.js + shadcn init | 1h |
| Protobuf toolchain + first proto files | 3h |
| justfile + mise.toml | 2h |
| GitHub Actions CI | 3h |
| Husky + lint-staged | 1h |
| Docker scaffold | 1h |
| Docs (CONTRIBUTING etc.) | 2h |
| Smoke test + debugging | 2h |
| **Total** | **~21h** |

Plan for 3 focused days.
