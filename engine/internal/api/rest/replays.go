package rest

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/charlses/clearvoiance/engine/internal/replay"
	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

type replayView struct {
	ID                  string   `json:"id"`
	SourceSessionID     string   `json:"source_session_id"`
	TargetURL           string   `json:"target_url"`
	Speedup             float64  `json:"speedup"`
	Label               string   `json:"label,omitempty"`
	Status              string   `json:"status"`
	StartedAt           string   `json:"started_at"`
	FinishedAt          *string  `json:"finished_at,omitempty"`
	EventsDispatched    int64    `json:"events_dispatched"`
	EventsFailed        int64    `json:"events_failed"`
	EventsBackpressured int64    `json:"events_backpressured"`
	P50LatencyMs        *float64 `json:"p50_latency_ms,omitempty"`
	P95LatencyMs        *float64 `json:"p95_latency_ms,omitempty"`
	P99LatencyMs        *float64 `json:"p99_latency_ms,omitempty"`
	MaxLagMs            *float64 `json:"max_lag_ms,omitempty"`
	ErrorMessage        string   `json:"error_message,omitempty"`
}

type startReplayReq struct {
	SourceSessionID  string  `json:"source_session_id"`
	TargetURL        string  `json:"target_url"`
	Speedup          float64 `json:"speedup,omitempty"`
	Label            string  `json:"label,omitempty"`
	VirtualUsers     int     `json:"virtual_users,omitempty"`
	HTTPWorkers      int     `json:"http_workers,omitempty"`
	TargetDurationMs int64   `json:"target_duration_ms,omitempty"`
	WindowStartNs    int64   `json:"window_start_offset_ns,omitempty"`
	WindowEndNs      int64   `json:"window_end_offset_ns,omitempty"`
}

type startReplayResp struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	StartedAt string `json:"started_at"`
}

func mountReplays(r chi.Router, d Deps) {
	h := &replayHandler{
		engine:  d.ReplayEngine,
		replays: d.MetaStore.Replays(),
	}
	r.Route("/replays", func(r chi.Router) {
		r.Post("/", h.start)
		r.Get("/{id}", h.get)
		r.Post("/{id}/cancel", h.cancel)
	})
}

type replayHandler struct {
	engine  *replay.Engine
	replays metadata.Replays
}

func (h *replayHandler) start(w http.ResponseWriter, r *http.Request) {
	var req startReplayReq
	if !ReadJSON(w, r, &req) {
		return
	}
	if req.SourceSessionID == "" {
		WriteError(w, http.StatusBadRequest, "BAD_REQUEST",
			"source_session_id is required", nil)
		return
	}
	if req.TargetURL == "" {
		WriteError(w, http.StatusBadRequest, "BAD_REQUEST",
			"target_url is required", nil)
		return
	}
	if req.Speedup <= 0 && req.TargetDurationMs <= 0 {
		req.Speedup = 1.0
	}
	if h.engine == nil {
		WriteError(w, http.StatusServiceUnavailable, "REPLAY_UNAVAILABLE",
			"replay engine is not configured (run with --clickhouse-dsn and --postgres-dsn)", nil)
		return
	}

	cfg := replay.Config{
		ReplayID:         replay.NewReplayID(),
		SourceSessionID:  req.SourceSessionID,
		TargetURL:        req.TargetURL,
		Speedup:          req.Speedup,
		Label:            req.Label,
		VirtualUsers:     req.VirtualUsers,
		TargetDurationMs: req.TargetDurationMs,
		WindowStartNs:    req.WindowStartNs,
		WindowEndNs:      req.WindowEndNs,
		MaxConcurrency:   req.HTTPWorkers,
	}

	// Detach so client disconnect doesn't kill the replay. Mirrors the gRPC
	// path.
	bgCtx := context.WithoutCancel(r.Context())
	go func() {
		_ = h.engine.Run(bgCtx, cfg)
	}()

	WriteJSON(w, http.StatusAccepted, startReplayResp{
		ID:        cfg.ReplayID,
		Status:    "pending",
		StartedAt: time.Now().UTC().Format("2006-01-02T15:04:05.999Z07:00"),
	})
}

func (h *replayHandler) get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	row, err := h.replays.Get(r.Context(), id)
	if err != nil {
		if errors.Is(err, metadata.ErrReplayNotFound) {
			WriteError(w, http.StatusNotFound, "REPLAY_NOT_FOUND",
				"Replay "+id+" not found", nil)
			return
		}
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"get replay: "+err.Error(), nil)
		return
	}
	WriteJSON(w, http.StatusOK, toReplayView(*row))
}

func (h *replayHandler) cancel(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if h.engine == nil {
		WriteError(w, http.StatusServiceUnavailable, "REPLAY_UNAVAILABLE",
			"replay engine is not configured", nil)
		return
	}
	cancelled := h.engine.Cancel(id)
	status := http.StatusAccepted
	if !cancelled {
		status = http.StatusNotFound
	}
	WriteJSON(w, status, map[string]any{
		"id":        id,
		"cancelled": cancelled,
	})
}

func toReplayView(r metadata.ReplayRow) replayView {
	v := replayView{
		ID:                  r.ID,
		SourceSessionID:     r.SourceSessionID,
		TargetURL:           r.TargetURL,
		Speedup:             r.Speedup,
		Label:               r.Label,
		Status:              r.Status,
		StartedAt:           r.StartedAt.Format("2006-01-02T15:04:05.999Z07:00"),
		EventsDispatched:    r.EventsDispatched,
		EventsFailed:        r.EventsFailed,
		EventsBackpressured: r.EventsBackpressured,
		P50LatencyMs:        r.P50LatencyMs,
		P95LatencyMs:        r.P95LatencyMs,
		P99LatencyMs:        r.P99LatencyMs,
		MaxLagMs:            r.MaxLagMs,
		ErrorMessage:        r.ErrorMessage,
	}
	if r.FinishedAt != nil {
		t := r.FinishedAt.Format("2006-01-02T15:04:05.999Z07:00")
		v.FinishedAt = &t
	}
	return v
}
