# syntax=docker/dockerfile:1.7

# Multi-stage Next.js (standalone output) build for the dashboard.
# Build context is the repo root so we can install the pnpm workspace.

# ---- deps: install workspace node_modules ----
FROM node:24-alpine AS deps
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY ui/package.json ./ui/
COPY sdk-node/package.json ./sdk-node/
COPY site/package.json ./site/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @clearvoiance/ui...

# ---- build: produce .next/standalone ----
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/ui/node_modules ./ui/node_modules
COPY pnpm-workspace.yaml package.json ./
COPY ui/ ./ui/

# NEXT_PUBLIC_* vars bake in at build time. Self-hosters override via
# compose's build.args (see deploy/docker-compose.yml).
ARG NEXT_PUBLIC_CLEARVOIANCE_API=http://localhost:9101
ENV NEXT_PUBLIC_CLEARVOIANCE_API=${NEXT_PUBLIC_CLEARVOIANCE_API}
ARG NEXT_PUBLIC_CLEARVOIANCE_DOCS=https://clearvoiance.vercel.app
ENV NEXT_PUBLIC_CLEARVOIANCE_DOCS=${NEXT_PUBLIC_CLEARVOIANCE_DOCS}

RUN pnpm --filter @clearvoiance/ui build

# ---- runtime: slim image with just the standalone server ----
FROM node:24-alpine AS runtime
RUN addgroup -S nodeapp && adduser -S nodeapp -G nodeapp
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# standalone bundles the traced minimal node_modules + server.js; static
# assets and the public/ dir are emitted separately and need copying in.
COPY --from=build --chown=nodeapp:nodeapp /repo/ui/.next/standalone ./
COPY --from=build --chown=nodeapp:nodeapp /repo/ui/.next/static ./ui/.next/static
COPY --from=build --chown=nodeapp:nodeapp /repo/ui/public ./ui/public

USER nodeapp
EXPOSE 3000
CMD ["node", "ui/server.js"]
