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
	// apiKeyRowCtxKey holds the validated APIKeyRow on Bearer-authed requests.
	apiKeyRowCtxKey contextKey = "clv.apiKeyRow"
)

// AuthMiddleware enforces that every /api/v1/* request carries EITHER:
//   - a valid session cookie (resolved upstream by SessionMiddleware), OR
//   - a valid `Authorization: Bearer <api_key>` header.
//
// The dashboard uses the cookie path; SDKs and any programmatic client
// continue to use Bearer. A request can carry both — cookie wins for the
// actor-identity attached to audit rows, but either alone is enough to
// pass auth.
//
// There is no dev-open mode. First-run bootstrap happens via
// /api/v1/auth/setup, which is mounted outside this middleware.
func AuthMiddleware(keys metadata.APIKeys) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Session cookie path (already resolved by SessionMiddleware).
			if UserFromCtx(r.Context()) != nil {
				next.ServeHTTP(w, r)
				return
			}

			// Bearer API key path.
			token := extractBearer(r)
			if token == "" {
				WriteError(w, http.StatusUnauthorized, "UNAUTHENTICATED",
					"session cookie or Authorization: Bearer <api_key> required", nil)
				return
			}

			row, err := keys.ValidateHash(r.Context(), HashAPIKey(token))
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
			ctx := context.WithValue(r.Context(), apiKeyRowCtxKey, row)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequireUser is a stricter gate than AuthMiddleware: the request MUST be
// session-cookie-authenticated (not Bearer). Used for endpoints that only
// make sense for a human dashboard user, like /auth/me and
// /auth/change-password.
func RequireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if UserFromCtx(r.Context()) == nil {
			WriteError(w, http.StatusUnauthorized, "UNAUTHENTICATED",
				"session cookie required", nil)
			return
		}
		next.ServeHTTP(w, r)
	})
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

// APIKeyFromCtx returns the validated row for the current request, or nil
// when the request was session-cookie-authenticated.
func APIKeyFromCtx(ctx context.Context) *metadata.APIKeyRow {
	v, _ := ctx.Value(apiKeyRowCtxKey).(*metadata.APIKeyRow)
	return v
}

// IsDevOpen is retained as a compatibility shim — always false now that
// dev-open is gone. Callers (a couple of tests + the audit writer) should
// be migrated off it, but keeping the symbol prevents an API break
// mid-refactor.
func IsDevOpen(_ context.Context) bool { return false }
