package rest

import (
	"context"
	"net/http"
	"time"

	"github.com/charlses/clearvoiance/engine/internal/storage"
	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

type healthHandler struct {
	engineVersion string
	store         storage.EventStore
	meta          metadata.Store
}

// Liveness probe. Returns 200 as long as the process is up.
func (h *healthHandler) health(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

// Readiness probe. Returns 200 when storage dependencies respond inside a
// short window; 503 otherwise.
func (h *healthHandler) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	checks := map[string]string{}

	// Lightweight meta probe: count api keys. Passes on noop.
	if _, err := h.meta.APIKeys().Count(ctx); err != nil {
		checks["metadata"] = err.Error()
	} else {
		checks["metadata"] = "ok"
	}

	status := http.StatusOK
	for _, v := range checks {
		if v != "ok" {
			status = http.StatusServiceUnavailable
			break
		}
	}
	WriteJSON(w, status, map[string]any{
		"status": statusLabel(status),
		"checks": checks,
	})
}

// Version info for the engine + SDK compatibility range.
func (h *healthHandler) version(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]any{
		"engine":     h.engineVersion,
		"api":        "v1",
		"sdk_compat": "@clearvoiance/node@0.0.0-alpha.0",
	})
}

func statusLabel(code int) string {
	if code >= 200 && code < 300 {
		return "ok"
	}
	return "unavailable"
}
