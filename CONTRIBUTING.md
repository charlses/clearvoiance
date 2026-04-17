# Contributing to clearvoiance

Thanks for considering a contribution. This document explains how to set up a dev environment, the coding standards we hold ourselves to, and the PR process.

## Setting up your dev environment

### Required tools

All tool versions are pinned via [`mise`](https://mise.jdx.dev/). One command installs everything:

```bash
mise install
```

If you prefer to manage tools yourself, install these versions (see `mise.toml` for exact pins):

- **Go** 1.22+
- **Node.js** 20+ (LTS)
- **pnpm** 9+
- **buf** 1.30+ (protobuf)
- **just** 1.25+ (task runner)
- **Docker** + Docker Compose

### First-time setup

```bash
git clone git@github.com:charlses/clearvoiance.git
cd clearvoiance
mise install           # installs pinned tool versions
just bootstrap         # installs all workspace deps, generates protos
```

You should now be able to:

```bash
just engine-build      # builds the Go engine
just sdk-build         # builds the Node SDK
just ui-dev            # starts the UI dev server
just test              # runs unit tests across the monorepo
```

### Running the full stack locally

```bash
just up                # docker compose up -d
just logs              # tail logs
just down              # tear down
```

## Repo layout

See [`plan/05-repo-structure.md`](./plan/05-repo-structure.md) for the full monorepo map. Short version:

- `engine/` — Go engine (gRPC ingest, replay, API)
- `db-observer/` — Go DB observer (Postgres correlation)
- `sdk-node/` — TypeScript SDK (`@clearvoiance/node`)
- `ui/` — Next.js control plane frontend
- `proto/` — shared protobuf definitions (source of truth)
- `deploy/` — docker-compose, Helm charts
- `examples/` — example apps using the SDK
- `plan/` — architecture + phase planning docs

## Coding standards

### Go

- `gofmt` + `goimports` enforced via pre-commit and CI.
- `golangci-lint` must pass (`just lint`).
- Package-level doc comment required on every public package.
- No global state unless explicitly justified in a comment.
- `internal/` for anything that isn't an external API.
- Prefer composition over inheritance-style patterns.

### TypeScript

- `prettier` + `eslint` enforced.
- Strict mode in `tsconfig.json` (`strict: true`, `noUncheckedIndexedAccess: true`).
- No `any` unless justified with a comment.
- Prefer named exports; default exports only for Next.js pages.

### Protobuf

- `buf lint` + `buf breaking` enforced.
- Never rename or change field numbers in shipped protos — add new fields instead.
- New RPCs get a doc comment explaining purpose.

### Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(engine): add replay scheduler timer wheel
fix(sdk): correctly redact nested JSON fields
docs(plan): update phase 2 acceptance criteria
```

Scope is the package name (`engine`, `sdk`, `ui`, `proto`, `plan`, etc.).

## Developer Certificate of Origin (DCO)

Every commit must be signed off to certify you wrote the code (or have the right to contribute it) under the project's license. Add `-s` to your commit:

```bash
git commit -s -m "feat(engine): add foo"
```

This appends `Signed-off-by: Your Name <email>` to the commit message. The DCO bot enforces this on PRs.

Read the full text at <https://developercertificate.org/>.

## Pull request process

1. **Open an issue first** for anything non-trivial. Describe the problem or feature.
2. **Fork + branch** from `main`. Name branches `feat/foo`, `fix/bar`, `docs/baz`.
3. **Make focused commits** — one logical change per commit.
4. **Write tests** — every PR adds or updates tests for the code it changes.
5. **Run `just ci-local`** before pushing — same checks as CI.
6. **Open the PR** — fill out the template; link the issue.
7. **Review** — maintainers will review within a week. Smaller PRs get reviewed faster.
8. **Squash merge** — PRs are squash-merged to `main` with a clean commit message.

## Writing adapters

SDK adapters for new frameworks are welcome. See [`plan/17-phase-7-adapters.md`](./plan/17-phase-7-adapters.md) for what's already planned and the adapter pattern.

Adapter PR checklist:

- [ ] Source under `sdk-node/src/adapters/<type>/<framework>.ts`
- [ ] Export added to `package.json` `exports` map
- [ ] Unit tests in `sdk-node/test/unit/adapters/<type>/<framework>.test.ts`
- [ ] Minimal example app in `examples/<framework>-basic/`
- [ ] Docs page at `docs/adapters/<framework>.md`
- [ ] Added to `README.md` adapter matrix

## Reporting security issues

**Do not open a public issue for security vulnerabilities.** See [`SECURITY.md`](./SECURITY.md) for private disclosure.

## Code of Conduct

Be kind. Assume good intent. This project follows the [Contributor Covenant](https://www.contributor-covenant.org/) v2.1. Violations may be reported to the maintainer privately.

## Questions?

- General discussion: [GitHub Discussions](https://github.com/charlses/clearvoiance/discussions)
- Bugs: [GitHub Issues](https://github.com/charlses/clearvoiance/issues)
- Security: see `SECURITY.md`
