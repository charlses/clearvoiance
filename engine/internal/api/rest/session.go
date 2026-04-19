// Session cookie layer for dashboard logins. Parallel to (not a replacement
// for) the bearer API key path in auth.go. Lookups hit UserSessions, not
// APIKeys; an authenticated request lands in the handler with a *UserRow
// attached to ctx, and downstream code that needs to know "who" can read it
// via UserFromCtx(). Programmatic API clients continue to use Bearer auth.

package rest

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

const (
	// SessionCookieName is the cookie carrying the opaque session token.
	SessionCookieName = "clv_session"
	// userRowCtxKey holds *metadata.UserRow for session-authenticated requests.
	userRowCtxKey contextKey = "clv.userRow"
)

// CookieConfig shapes the Set-Cookie header for session cookies. Computed
// once at startup from CLI flags + request scheme.
type CookieConfig struct {
	// Domain to scope the cookie to. Empty = host-only. Set to a parent
	// like ".charlses.com" when the dashboard and engine are on different
	// subdomains of the same registrable domain.
	Domain string
	// Secure: set based on request TLS / X-Forwarded-Proto per request.
	// This struct only holds the *minimum* — if the incoming request is
	// HTTPS we always add Secure regardless.
	AlwaysSecure bool
	// TTL for new sessions.
	TTL time.Duration
	// SameSite policy. Lax is the sweet spot: cross-subdomain fetches
	// (same-site under RFC 6265bis) pass, third-party context is blocked.
	SameSite http.SameSite
}

// DefaultCookieConfig: 7-day sessions, Lax same-site, no explicit domain
// (browser treats as host-only). Production should set Domain explicitly
// when serving dashboard + engine on different subdomains.
var DefaultCookieConfig = CookieConfig{
	Domain:       "",
	AlwaysSecure: false,
	TTL:          7 * 24 * time.Hour,
	SameSite:     http.SameSiteLaxMode,
}

// SessionMiddleware resolves the session cookie into a UserRow and attaches
// it to the request context. Does NOT enforce auth on its own — combined
// with AuthMiddleware to form the "session OR Bearer" policy.
func SessionMiddleware(users metadata.Users, sessions metadata.UserSessions) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := extractSessionToken(r)
			if token == "" {
				next.ServeHTTP(w, r)
				return
			}

			sess, err := sessions.Lookup(r.Context(), HashSessionToken(token))
			if err != nil {
				// Unknown or expired → treat as unauthenticated. The
				// bearer path gets a chance next.
				next.ServeHTTP(w, r)
				return
			}
			user, err := users.GetByID(r.Context(), sess.UserID)
			if err != nil {
				// Dangling cookie (user deleted, FK cascade not yet run);
				// clear it and keep going unauthenticated.
				next.ServeHTTP(w, r)
				return
			}

			ctx := context.WithValue(r.Context(), userRowCtxKey, user)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// UserFromCtx returns the authenticated user for a session-authed request,
// or nil if the request was anonymous or Bearer-authed.
func UserFromCtx(ctx context.Context) *metadata.UserRow {
	v, _ := ctx.Value(userRowCtxKey).(*metadata.UserRow)
	return v
}

// extractSessionToken reads the session token from the cookie. Returns ""
// if the cookie is missing / empty.
func extractSessionToken(r *http.Request) string {
	c, err := r.Cookie(SessionCookieName)
	if err != nil || c.Value == "" {
		return ""
	}
	return strings.TrimSpace(c.Value)
}

// HashSessionToken is sha256(plaintext), hex-encoded. Matches the one-way
// storage pattern used for API keys: we never persist the plaintext.
func HashSessionToken(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

// NewSessionToken returns 32 bytes of crypto/rand, base64-URL-encoded —
// roughly 256 bits of entropy. The caller stores sha256(token) in the DB
// and sends the plaintext to the client via Set-Cookie.
func NewSessionToken() (string, error) {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf[:]), nil
}

// SetSessionCookie writes the Set-Cookie header carrying a freshly-minted
// session token. Secure is inferred from the request scheme plus the
// AlwaysSecure flag — that way it works for local plain-HTTP dev without
// refusing to deploy behind TLS termination.
func SetSessionCookie(w http.ResponseWriter, r *http.Request, token string, cfg CookieConfig) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    token,
		Path:     "/",
		Domain:   cfg.Domain,
		HttpOnly: true,
		Secure:   cfg.AlwaysSecure || isRequestSecure(r),
		SameSite: cfg.SameSite,
		Expires:  time.Now().Add(cfg.TTL),
		MaxAge:   int(cfg.TTL.Seconds()),
	})
}

// ClearSessionCookie tells the browser to drop the session cookie. Mirrors
// the attributes of SetSessionCookie so the browser actually recognizes it.
func ClearSessionCookie(w http.ResponseWriter, r *http.Request, cfg CookieConfig) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    "",
		Path:     "/",
		Domain:   cfg.Domain,
		HttpOnly: true,
		Secure:   cfg.AlwaysSecure || isRequestSecure(r),
		SameSite: cfg.SameSite,
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
	})
}

// isRequestSecure is TLS-or-Forwarded-Proto=https. Behind Traefik the TLS
// is terminated at the proxy so r.TLS is nil — the X-Forwarded-Proto
// header is how we know the original request was HTTPS.
func isRequestSecure(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}
