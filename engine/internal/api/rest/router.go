package rest

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/charlses/clearvoiance/engine/internal/replay"
	"github.com/charlses/clearvoiance/engine/internal/sessions"
	"github.com/charlses/clearvoiance/engine/internal/storage"
	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

// Deps is every dependency the REST handlers need. Passed in at wire-up so
// tests can swap in Noop implementations without touching the router.
type Deps struct {
	Log           *slog.Logger
	Version       string
	ClickhouseDSN string
	SessionMgr    *sessions.Manager
	EventStore    storage.EventStore
	MetaStore     metadata.Store
	ReplayEngine  *replay.Engine
	// AuditLogger is optional; wiring it in turns every write into an
	// audit_log row. Can be nil in tests or when not desired.
	AuditLogger AuditWriter
	// Metrics is the counters exposed on /metrics. When non-nil it's also
	// installed as request-counting middleware.
	Metrics *MetricsRegistry
	// Config is the read-only slice of runtime config surfaced on /config.
	Config ConfigView
	// Cookie shapes Set-Cookie for dashboard sessions. Zero-value falls
	// back to DefaultCookieConfig.
	Cookie CookieConfig
	// CORS controls cross-origin access. Empty AllowedOrigins = no CORS
	// headers (same-origin or Bearer-only deploys).
	CORS CORSConfig
	// Argon2 tunes password hashing. Zero-value falls back to
	// DefaultArgon2idParams.
	Argon2 Argon2idParams
}

// Router builds the full REST surface. Mount under `/api/v1` on whatever
// http.Server serves it; see engine/internal/cli/serve.go.
func Router(d Deps) http.Handler {
	cookieCfg := d.Cookie
	if cookieCfg.TTL == 0 {
		cookieCfg = DefaultCookieConfig
	}
	argon2 := d.Argon2
	if argon2.Memory == 0 {
		argon2 = DefaultArgon2idParams
	}
	aDeps := authDeps{
		users:    d.MetaStore.Users(),
		sessions: d.MetaStore.UserSessions(),
		cookie:   cookieCfg,
		argon2:   argon2,
	}

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(recoverMiddleware(d.Log))
	r.Use(corsMiddleware(d.CORS))
	// Resolve session cookies before auth so the bearer path only runs
	// when there's no live session.
	r.Use(SessionMiddleware(d.MetaStore.Users(), d.MetaStore.UserSessions()))
	if d.Metrics != nil {
		r.Use(MetricsMiddleware(d.Metrics))
	}

	r.Route("/api/v1", func(r chi.Router) {
		// Unauthenticated operational endpoints.
		h := &healthHandler{engineVersion: d.Version, store: d.EventStore, meta: d.MetaStore}
		r.Get("/health", h.health)
		r.Get("/ready", h.ready)
		r.Get("/version", h.version)
		mountMetrics(r, d.Metrics)

		// /auth/* — mixes public (setup, login, state) and session-gated
		// (me, change-password). Internal guards via RequireUser.
		mountAuth(r, aDeps)

		// Everything else requires auth (session OR bearer).
		r.Group(func(r chi.Router) {
			r.Use(AuthMiddleware(d.MetaStore.APIKeys()))
			if d.AuditLogger != nil {
				r.Use(AuditMiddleware(d.AuditLogger))
			}

			mountConfig(r, configViewFromDeps(d))
			mountSessions(r, d)
			mountReplays(r, d)
			mountAPIKeys(r, d)
			mountDbObservations(r, d)
		})
	})

	// OpenAPI + Swagger UI — hand-written spec, static UI assets. Opted
	// into via /docs + /api/v1/openapi.json.
	MountOpenAPI(r, d.Version)
	return r
}

// configViewFromDeps merges runtime Deps into a ConfigView that mountConfig
// then further redacts + serves.
func configViewFromDeps(d Deps) ConfigView {
	v := d.Config
	v.Version = d.Version
	if v.Clickhouse == "" {
		v.Clickhouse = d.ClickhouseDSN
	}
	if v.Features == nil {
		v.Features = map[string]bool{}
	}
	v.Features["db_observer_reads"] = d.ClickhouseDSN != ""
	v.Features["replay_engine"] = d.ReplayEngine != nil
	v.Features["audit_log"] = d.AuditLogger != nil
	return v
}

// recoverMiddleware turns handler panics into 500s so one handler bug doesn't
// nuke the whole server.
func recoverMiddleware(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					log.Error("rest: handler panic",
						"method", r.Method,
						"path", r.URL.Path,
						"panic", rec,
					)
					WriteError(w, http.StatusInternalServerError, "INTERNAL",
						"internal server error", nil)
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}
