package rest

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/charlses/clearvoiance/engine/internal/sessions"
	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

type sessionView struct {
	ID             string            `json:"id"`
	Name           string            `json:"name"`
	Labels         map[string]string `json:"labels"`
	Status         string            `json:"status"`
	StartedAt      string            `json:"started_at"`
	StoppedAt      *string           `json:"stopped_at,omitempty"`
	EventsCaptured int64             `json:"events_captured"`
	BytesCaptured  int64             `json:"bytes_captured"`
}

func mountSessions(r chi.Router, d Deps) {
	h := &sessionHandler{mgr: d.SessionMgr, meta: d.MetaStore.Sessions()}
	r.Route("/sessions", func(r chi.Router) {
		r.Get("/", h.list)
		r.Get("/{id}", h.get)
		r.Post("/{id}/stop", h.stop)
		r.Get("/{id}/stats", h.stats)
	})
}

type sessionHandler struct {
	mgr  *sessions.Manager
	meta metadata.Sessions
}

func (h *sessionHandler) list(w http.ResponseWriter, r *http.Request) {
	rows, err := h.meta.List(r.Context())
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"list sessions: "+err.Error(), nil)
		return
	}

	statusFilter := r.URL.Query().Get("status")
	limit := intQuery(r, "limit", 100)
	out := make([]sessionView, 0, len(rows))
	for _, s := range rows {
		if statusFilter != "" && s.Status != statusFilter {
			continue
		}
		out = append(out, toSessionView(s))
		if len(out) >= limit {
			break
		}
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"sessions": out,
		"count":    len(out),
	})
}

func (h *sessionHandler) get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	row, err := h.meta.Get(r.Context(), id)
	if err != nil {
		if errors.Is(err, metadata.ErrSessionNotFound) {
			WriteError(w, http.StatusNotFound, "SESSION_NOT_FOUND",
				"Session "+id+" not found", nil)
			return
		}
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"get session: "+err.Error(), nil)
		return
	}
	WriteJSON(w, http.StatusOK, toSessionView(*row))
}

func (h *sessionHandler) stop(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	sess, err := h.mgr.Stop(r.Context(), id)
	if err != nil {
		switch {
		case errors.Is(err, sessions.ErrNotFound):
			WriteError(w, http.StatusNotFound, "SESSION_NOT_FOUND",
				"Session "+id+" not found", nil)
		case errors.Is(err, sessions.ErrAlreadyStopped):
			WriteError(w, http.StatusConflict, "SESSION_ALREADY_STOPPED",
				"Session "+id+" is already stopped", nil)
		default:
			WriteError(w, http.StatusInternalServerError, "INTERNAL",
				"stop session: "+err.Error(), nil)
		}
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"id":              sess.ID,
		"status":          string(sess.Status),
		"stopped_at":      sess.StoppedAt.Format("2006-01-02T15:04:05.999Z07:00"),
		"events_captured": sess.EventsCaptured.Load(),
		"bytes_captured":  sess.BytesCaptured.Load(),
	})
}

func (h *sessionHandler) stats(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	row, err := h.meta.Get(r.Context(), id)
	if err != nil {
		if errors.Is(err, metadata.ErrSessionNotFound) {
			WriteError(w, http.StatusNotFound, "SESSION_NOT_FOUND",
				"Session "+id+" not found", nil)
			return
		}
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"get session: "+err.Error(), nil)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"id":              row.ID,
		"status":          row.Status,
		"events_captured": row.EventsCaptured,
		"bytes_captured":  row.BytesCaptured,
		"started_at":      row.StartedAt.Format("2006-01-02T15:04:05.999Z07:00"),
	})
}

func toSessionView(s metadata.SessionRow) sessionView {
	v := sessionView{
		ID:             s.ID,
		Name:           s.Name,
		Labels:         s.Labels,
		Status:         s.Status,
		StartedAt:      s.StartedAt.Format("2006-01-02T15:04:05.999Z07:00"),
		EventsCaptured: s.EventsCaptured,
		BytesCaptured:  s.BytesCaptured,
	}
	if v.Labels == nil {
		v.Labels = map[string]string{}
	}
	if s.StoppedAt != nil {
		t := s.StoppedAt.Format("2006-01-02T15:04:05.999Z07:00")
		v.StoppedAt = &t
	}
	return v
}

func intQuery(r *http.Request, name string, def int) int {
	v := r.URL.Query().Get(name)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return def
	}
	return n
}
