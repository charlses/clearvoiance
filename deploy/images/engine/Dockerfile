# syntax=docker/dockerfile:1.7

# ---- build stage ----
FROM golang:1.22-alpine AS build

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

# ---- runtime ----
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/clearvoiance /usr/local/bin/clearvoiance

EXPOSE 8080 9100
USER nonroot:nonroot

ENTRYPOINT ["/usr/local/bin/clearvoiance"]
CMD ["serve"]
