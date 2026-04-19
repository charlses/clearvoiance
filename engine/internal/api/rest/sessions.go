package rest

import (
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"google.golang.org/protobuf/proto"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
	"github.com/charlses/clearvoiance/engine/internal/sessions"
	"github.com/charlses/clearvoiance/engine/internal/storage"
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
	h := &sessionHandler{
		mgr:        d.SessionMgr,
		meta:       d.MetaStore.Sessions(),
		eventStore: d.EventStore,
	}
	r.Route("/sessions", func(r chi.Router) {
		r.Get("/", h.list)
		r.Get("/{id}", h.get)
		r.Delete("/{id}", h.delete)
		r.Post("/{id}/stop", h.stop)
		r.Get("/{id}/stats", h.stats)
		r.Get("/{id}/events", h.events)
	})
}

type sessionHandler struct {
	mgr        *sessions.Manager
	meta       metadata.Sessions
	eventStore storage.EventStore
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
		v := toSessionView(s)
		h.overlayLive(r, &v)
		out = append(out, v)
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
	v := toSessionView(*row)
	h.overlayLive(r, &v)
	WriteJSON(w, http.StatusOK, v)
}

// overlayLive swaps in the in-memory live counters when the session is
// still active. The Postgres row only gets events_captured/bytes_captured
// updated on stop, so a live session reads zero from the row — this
// method bridges the gap.
func (h *sessionHandler) overlayLive(r *http.Request, v *sessionView) {
	if v.Status != "active" || h.mgr == nil {
		return
	}
	live, err := h.mgr.Get(r.Context(), v.ID)
	if err != nil || live == nil {
		return
	}
	v.EventsCaptured = live.EventsCaptured.Load()
	v.BytesCaptured = live.BytesCaptured.Load()
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
	events, bytes := row.EventsCaptured, row.BytesCaptured
	if row.Status == "active" && h.mgr != nil {
		if live, err := h.mgr.Get(r.Context(), id); err == nil && live != nil {
			events = live.EventsCaptured.Load()
			bytes = live.BytesCaptured.Load()
		}
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"id":              row.ID,
		"status":          row.Status,
		"events_captured": events,
		"bytes_captured":  bytes,
		"started_at":      row.StartedAt.Format("2006-01-02T15:04:05.999Z07:00"),
	})
}

func (h *sessionHandler) delete(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	// Best-effort event cleanup: only when the event store supports it.
	// Metadata row is always removed below.
	if del, ok := h.eventStore.(storage.DeleteSessionCapable); ok {
		_ = del.DeleteSession(r.Context(), id)
	}
	if err := h.meta.Delete(r.Context(), id); err != nil {
		if errors.Is(err, metadata.ErrSessionNotFound) {
			WriteError(w, http.StatusNotFound, "SESSION_NOT_FOUND",
				"Session "+id+" not found", nil)
			return
		}
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"delete session: "+err.Error(), nil)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// events returns a page of captured events for a session. Bodies and raw
// protobufs are base64-encoded; for browser-friendly viewing, use the UI
// which renders them post-decode.
func (h *sessionHandler) events(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	limit := intQuery(r, "limit", 100)

	reader, ok := h.eventStore.(storage.SessionEventReader)
	if !ok {
		WriteJSON(w, http.StatusOK, map[string]any{
			"session_id": id,
			"events":     []any{},
			"note":       "event store backend does not support session-event reads (running ephemerally?)",
		})
		return
	}
	events, err := reader.ReadSessionEvents(r.Context(), id, limit)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"read events: "+err.Error(), nil)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"session_id": id,
		"events":     toEventViews(events),
		"count":      len(events),
	})
}

// eventView is a UI-friendlier envelope — core metadata pulled up, the full
// encoded protobuf kept as base64 for clients that want everything.
type eventView struct {
	ID          string            `json:"id"`
	TimestampNs int64             `json:"timestamp_ns"`
	OffsetNs    int64             `json:"offset_ns"`
	DurationNs  int64             `json:"duration_ns,omitempty"`
	Adapter     string            `json:"adapter"`
	EventType   string            `json:"event_type"`
	HTTPMethod  string            `json:"http_method,omitempty"`
	HTTPPath    string            `json:"http_path,omitempty"`
	HTTPStatus  int32             `json:"http_status,omitempty"`
	Metadata    map[string]string `json:"metadata,omitempty"`
	RawPB       string            `json:"raw_pb_b64,omitempty"`
}

func toEventViews(events []*pb.Event) []eventView {
	out := make([]eventView, 0, len(events))
	for _, ev := range events {
		view := eventView{
			ID:          ev.GetId(),
			TimestampNs: ev.GetTimestampNs(),
			OffsetNs:    ev.GetOffsetNs(),
			Adapter:     ev.GetAdapter(),
			Metadata:    ev.GetMetadata(),
		}
		switch p := ev.GetPayload().(type) {
		case *pb.Event_Http:
			view.EventType = "http"
			view.HTTPMethod = p.Http.GetMethod()
			view.HTTPPath = p.Http.GetPath()
			view.HTTPStatus = p.Http.GetStatus()
			view.DurationNs = p.Http.GetDurationNs()
		case *pb.Event_Socket:
			view.EventType = "socket"
			view.DurationNs = p.Socket.GetDurationNs()
		case *pb.Event_Cron:
			view.EventType = "cron"
			view.DurationNs = p.Cron.GetDurationNs()
		case *pb.Event_Webhook:
			view.EventType = "webhook"
		case *pb.Event_Queue:
			view.EventType = "queue"
			view.DurationNs = p.Queue.GetDurationNs()
		case *pb.Event_Outbound:
			view.EventType = "outbound"
		case *pb.Event_Db:
			view.EventType = "db"
			view.DurationNs = p.Db.GetDurationNs()
		}
		if raw, err := proto.Marshal(ev); err == nil {
			view.RawPB = base64.StdEncoding.EncodeToString(raw)
		}
		out = append(out, view)
	}
	return out
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
