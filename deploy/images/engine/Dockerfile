# syntax=docker/dockerfile:1.7

# ---- build stage ----
FROM golang:1.26-alpine AS build

WORKDIR /src

# Copy Go workspace + module manifests first for better layer caching.
COPY go.work ./
COPY engine/go.mod engine/go.sum ./engine/
COPY db-observer/go.mod ./db-observer/

# If db-observer gets a go.sum in a later phase, uncomment:
# COPY db-observer/go.sum ./db-observer/

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    cd engine && go mod download

COPY engine/ ./engine/
COPY db-observer/ ./db-observer/

ARG VERSION=0.0.0-dev
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux \
    go build \
      -ldflags="-s -w -X main.version=${VERSION}" \
      -o /out/clearvoiance \
      ./engine/cmd/clearvoiance
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux \
    go build \
      -ldflags="-s -w -X main.version=${VERSION}" \
      -o /out/clearvoiance-observer \
      ./db-observer/cmd/clearvoiance-observer

# ---- runtime ----
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/clearvoiance /usr/local/bin/clearvoiance
COPY --from=build /out/clearvoiance-observer /usr/local/bin/clearvoiance-observer

EXPOSE 9100 9101
USER nonroot:nonroot

# Default entrypoint runs the engine; compose overrides `entrypoint:` for
# the optional db-observer service.
ENTRYPOINT ["/usr/local/bin/clearvoiance"]
CMD ["serve"]
