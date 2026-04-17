# Phase 8 — OSS Launch

**Duration:** 1 week.
**Goal:** Public release. External users can clone, install, use, and contribute.

## Deliverables

### Documentation site

`docs/` → deployed to `docs.clearvoiance.io` (Vercel + Mintlify OR self-hosted Docusaurus).

Structure:

```
docs/
├── introduction/
│   ├── what-is-clearvoiance.md
│   ├── why.md
│   └── architecture-overview.md
├── getting-started/
│   ├── quickstart-self-host.md   # 5-min: docker compose + demo
│   ├── quickstart-express.md
│   ├── quickstart-strapi.md
│   └── quickstart-nest.md
├── concepts/
│   ├── sessions.md
│   ├── events.md
│   ├── replay.md
│   ├── hermetic-mode.md
│   ├── db-observability.md
│   └── virtual-users.md
├── guides/
│   ├── setting-up-postgres-observer.md
│   ├── configuring-auth-strategies.md
│   ├── pii-redaction-best-practices.md
│   ├── ci-integration.md          # run replay as a release gate
│   ├── scaling-for-production.md
│   └── troubleshooting.md
├── adapters/
│   ├── http-express.md
│   ├── http-strapi.md
│   ├── http-fastify.md
│   ├── ...                        # one per adapter
├── api-reference/
│   ├── rest.md                    # auto-generated from OpenAPI
│   ├── websocket.md
│   ├── sdk-node.md                # auto-generated from TSDoc
│   └── cli.md                     # auto-generated from cobra
├── operations/
│   ├── self-hosting-docker.md
│   ├── self-hosting-kubernetes.md
│   ├── configuration-reference.md
│   ├── metrics-and-monitoring.md
│   ├── backup-and-retention.md
│   └── security-hardening.md
├── contributing/
│   ├── dev-environment.md
│   ├── coding-standards.md
│   ├── writing-adapters.md
│   └── release-process.md
└── changelog.md
```

### Quickstart (5 minutes)

The most important page. Test it with someone who hasn't seen the project:

```
git clone https://github.com/<org>/clearvoiance.git
cd clearvoiance/deploy
docker compose up -d

# Visit http://localhost:3000 for UI
# UI walks you through: create API key → create session → copy SDK snippet

# In your app:
pnpm add @clearvoiance/node

# Paste snippet. Run your app. Make some requests.
# Back in UI: watch events stream in live.

# Stop session. Click "Replay". Configure speed, target. Go.
# Watch the stress test run.
```

If this takes more than 10 minutes for an experienced dev, the docs have failed.

### Deployment artifacts

#### Docker Compose

`deploy/docker-compose.yml`:
- engine
- ui
- clickhouse
- minio
- postgres
- Optional: example-strapi (commented out, opt-in for first-time users)

Single `docker compose up -d` brings up everything. Bind mounts for persistence. Default credentials documented + warnings to change.

#### Helm chart

`deploy/helm/clearvoiance/`:
- Values for single-node dev vs. multi-replica prod.
- StatefulSets for ClickHouse and Postgres.
- Ingress templates for UI + API.
- NetworkPolicy defaults.
- PodSecurityContext + SecurityContext hardening.

Tested against k3d, kind, and a real cluster (GKE or EKS).

#### Docker images

Multi-arch (linux/amd64, linux/arm64) on GitHub Container Registry:

- `ghcr.io/<org>/clearvoiance-engine:<version>`
- `ghcr.io/<org>/clearvoiance-ui:<version>`
- `ghcr.io/<org>/clearvoiance-observer:<version>`

Tagging: `latest`, `vX.Y.Z`, `vX.Y`, `vX`.

#### Binary releases

- `clearvoiance_0.1.0_linux_amd64.tar.gz`
- `clearvoiance_0.1.0_linux_arm64.tar.gz`
- `clearvoiance_0.1.0_darwin_amd64.tar.gz`
- `clearvoiance_0.1.0_darwin_arm64.tar.gz`

Published to GitHub Releases via `goreleaser`.

#### npm package

`@clearvoiance/node@0.1.0` published to npm. Dual ESM+CJS. Subpath exports. Proper `peerDependencies`.

### Public website

`clearvoiance.io` (separate repo, static site):

- Hero: "Stress test with real traffic."
- 60-second demo video (embed).
- Key features.
- Links to docs, GitHub, Discord.
- "Star on GitHub" + star count.

### Launch plan

#### Pre-launch (day -3 to day -1)

- Final QA pass on quickstart.
- Docs review (have someone outside the team read it).
- Tag `v0.1.0`, push binaries + images.
- Publish `@clearvoiance/node@0.1.0`.
- Draft launch posts (HN, Reddit, Twitter, Dev.to, Product Hunt).
- Record demo video.

#### Launch day

- HN Show post (aim for Tuesday-Thursday morning).
- Reddit: r/programming, r/golang, r/node, r/devops.
- Twitter thread from maintainer + co-signed RTs.
- Dev.to + Hashnode posts.
- Product Hunt launch.
- Post in relevant Discords: Go, Node, Strapi.
- Email to pre-launch signup list (if any).

#### Post-launch (week 1)

- Monitor GitHub issues aggressively.
- Respond to HN comments within 1 hour of each wave.
- Fix any top-of-funnel install/config issues same-day.
- Blog follow-up: "What we learned from the launch."

### Community infra

- **GitHub Discussions** enabled (preferred over Slack for async).
- **Discord** server (for real-time).
- **Twitter account** (announcements, releases).
- **Issue triage label set**: `bug`, `feature`, `good-first-issue`, `help-wanted`, `needs-info`, `wontfix`.
- **Release notes**: detailed per-version, with migration guides for breaking changes.

### License headers

Every source file gets an Apache-2.0 header:

```go
// Copyright 2026 <Org>.
// SPDX-License-Identifier: Apache-2.0
```

Automated via `scripts/add-license-headers.sh` + CI check.

### Trademark / name search

Before launch, verify "clearvoiance" is:
- Available as `.io`, `.com`, `.dev` domains.
- Not a registered trademark in the same software class.
- Not an existing OSS project with significant presence.

If conflicts → rename. Budget 1 day contingency.

### Security disclosures

`SECURITY.md` with:
- Private disclosure email: `security@<domain>`.
- GPG key for encrypted reports.
- Response SLA (72h initial, 30d resolution target).
- Hall of fame section.

### Analytics (privacy-respecting)

- Docs site: Plausible or Umami (no cookies, no personal data).
- npm download stats (public).
- Docker image pull stats (public).
- GitHub star/fork stats.

NO analytics in the engine or SDK. Self-hosted tools don't call home.

## Acceptance criteria

1. External user clones repo fresh, follows quickstart, has a working capture + replay in < 15 minutes.
2. `pnpm add @clearvoiance/node` installs a working package.
3. `docker pull ghcr.io/<org>/clearvoiance-engine:latest` works.
4. `docs.clearvoiance.io` loads, search works, API reference reflects current code.
5. Helm chart installs cleanly on a fresh cluster.
6. License headers present on every source file (CI-enforced).
7. No secrets, no credentials, no internal references in the public repo.

## Non-goals

- Enterprise features (SSO, RBAC beyond single-role, audit dashboards) — roadmapped but not v1.
- Paid/SaaS offering — open source first; SaaS is a later business decision.
- Marketing SEO push — grow organically first 6 months.

## Implementation order

1. Name/trademark/domain check.
2. Docs site scaffolding + content (majority of Phase 8 effort).
3. Quickstart testing with external users.
4. Helm chart.
5. Docker image publishing workflow.
6. npm publish workflow.
7. goreleaser.
8. Landing site (clearvoiance.io).
9. Launch content (posts, video).
10. Launch.

## Open questions

- **License choice re-confirmed?** Apache-2.0. (Decision log in `22-open-questions.md`.)
- **Repo name vs. product name:** repo `clearvoiance` on GitHub under <org>. Or under personal account and transfer later?
- **Monorepo public:** yes. Contributors expect to find everything in one place.
- **Funding/sponsorship:** GitHub Sponsors enabled? Open Collective? Defer, enable after 500 stars.

## Time budget

| Area | Estimate |
|---|---|
| Docs content (primary effort) | 3 days |
| Helm chart + k8s testing | 1 day |
| Docker/npm/goreleaser pipelines | 1 day |
| Landing site | 1 day |
| Launch content | 1 day |
| Buffer (name/trademark fallback) | 1 day |
| **Total** | **~7 days** |
