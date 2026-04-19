// CORS middleware. The dashboard (e.g. clearvoiance-dashboard.charlses.com)
// and the engine (clearvoiance-api.charlses.com) live on different origins
// but share a session cookie scoped to the parent domain. Browsers won't
// send cookies cross-origin unless the response carries
// `Access-Control-Allow-Credentials: true` plus an explicit origin — `*`
// is forbidden when credentials are in play, so we maintain an exact-match
// allow-list.

package rest

import (
	"net/http"
	"strings"
)

// CORSConfig is the operator-facing tuning surface. Empty AllowedOrigins
// disables CORS entirely (useful for loopback-only deploys where the
// dashboard + engine are same-origin or where only Bearer clients hit
// the API).
type CORSConfig struct {
	// AllowedOrigins is the set of Origin header values that pass. Exact
	// match (after trimming a trailing slash), no wildcards.
	AllowedOrigins []string
	// AllowCredentials sets Access-Control-Allow-Credentials: true.
	// Required for cookies to survive cross-origin fetches.
	AllowCredentials bool
}

// corsMiddleware applies CORSConfig. If AllowedOrigins is empty, it's a
// pass-through (no CORS headers added, no preflight short-circuit).
func corsMiddleware(cfg CORSConfig) func(http.Handler) http.Handler {
	if len(cfg.AllowedOrigins) == 0 {
		return func(next http.Handler) http.Handler { return next }
	}
	allow := map[string]bool{}
	for _, o := range cfg.AllowedOrigins {
		allow[strings.TrimRight(o, "/")] = true
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := strings.TrimRight(r.Header.Get("Origin"), "/")
			if origin != "" && allow[origin] {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
				if cfg.AllowCredentials {
					w.Header().Set("Access-Control-Allow-Credentials", "true")
				}
				w.Header().Set("Access-Control-Allow-Methods",
					"GET, POST, PUT, PATCH, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers",
					"Content-Type, Authorization, X-Requested-With")
				w.Header().Set("Access-Control-Max-Age", "86400")
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
