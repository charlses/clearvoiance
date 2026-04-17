package rest

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"

	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

type contextKey string

const (
	// apiKeyRowCtxKey holds the validated APIKeyRow on authenticated requests.
	apiKeyRowCtxKey contextKey = "clv.apiKeyRow"
	// devOpenCtxKey is set to true when auth passed under dev-open (no keys).
	devOpenCtxKey contextKey = "clv.devOpen"
)

// AuthMiddleware validates `Authorization: Bearer <key>` against the metadata
// store. Dev-open: when no keys are provisioned yet, accepts any non-empty
// Bearer value — same policy as the gRPC side, so bootstrapping from zero
// keys doesn't require a side channel.
func AuthMiddleware(keys metadata.APIKeys) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Skip auth on unauthenticated endpoints — the router mounts this
			// middleware only on /api/v1/* so health/docs/root aren't gated.
			token := extractBearer(r)
			if token == "" {
				WriteError(w, http.StatusUnauthorized, "UNAUTHENTICATED",
					"Authorization: Bearer <api_key> is required", nil)
				return
			}

			ctx := r.Context()
			count, err := keys.Count(ctx)
			if err != nil {
				// Fail open on transient metadata errors so a Postgres
				// hiccup doesn't 500 every request. Mirrors the gRPC path.
				ctx = context.WithValue(ctx, devOpenCtxKey, true)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
			if count == 0 {
				ctx = context.WithValue(ctx, devOpenCtxKey, true)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}

			row, err := keys.ValidateHash(ctx, HashAPIKey(token))
			if err != nil {
				if errors.Is(err, metadata.ErrAPIKeyNotFound) {
					WriteError(w, http.StatusUnauthorized, "UNAUTHENTICATED",
						"invalid or revoked API key", nil)
					return
				}
				WriteError(w, http.StatusInternalServerError, "INTERNAL",
					"validate api key: "+err.Error(), nil)
				return
			}
			ctx = context.WithValue(ctx, apiKeyRowCtxKey, row)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// extractBearer grabs the token from `Authorization: Bearer <token>`.
func extractBearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if h == "" {
		return ""
	}
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		return ""
	}
	return strings.TrimSpace(h[len(prefix):])
}

// HashAPIKey hex-encodes sha256(plaintext). Same algorithm as the gRPC side
// so a key created there validates here and vice versa.
func HashAPIKey(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

// APIKeyFromCtx returns the validated row for the current request, or nil in
// dev-open mode.
func APIKeyFromCtx(ctx context.Context) *metadata.APIKeyRow {
	v, _ := ctx.Value(apiKeyRowCtxKey).(*metadata.APIKeyRow)
	return v
}

// IsDevOpen reports whether the current request was authenticated in
// dev-open mode (any non-empty key accepted because no keys exist yet).
func IsDevOpen(ctx context.Context) bool {
	v, _ := ctx.Value(devOpenCtxKey).(bool)
	return v
}
