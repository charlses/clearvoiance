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
	Log             *slog.Logger
	Version         string
	ClickhouseDSN   string
	SessionMgr      *sessions.Manager
	EventStore      storage.EventStore
	MetaStore       metadata.Store
	ReplayEngine    *replay.Engine
	// AuditLogger is optional; wiring it in turns every write into an
	// audit_log row. Can be nil in tests or when not desired.
	AuditLogger AuditWriter
}

// Router builds the full REST surface. Mount under `/api/v1` on whatever
// http.Server serves it; see engine/internal/cli/serve.go.
func Router(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(recoverMiddleware(d.Log))

	// Unauthenticated operational endpoints.
	r.Route("/api/v1", func(r chi.Router) {
		h := &healthHandler{engineVersion: d.Version, store: d.EventStore, meta: d.MetaStore}
		r.Get("/health", h.health)
		r.Get("/ready", h.ready)
		r.Get("/version", h.version)

		// Everything else requires auth.
		r.Group(func(r chi.Router) {
			r.Use(AuthMiddleware(d.MetaStore.APIKeys()))
			if d.AuditLogger != nil {
				r.Use(AuditMiddleware(d.AuditLogger))
			}

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
