// REST surface for remote-controlled capture clients ("monitors").
// Dashboard uses these to list known clients, start capture on one,
// and stop an active capture — all pushed down through the
// ControlService gRPC stream that the SDK is keeping open.
//
// Runtime "is this monitor online + how many replicas?" comes from the
// ControlPusher (the gRPC ControlServer's in-memory stream registry).
// Persistent state (capture_enabled, active_session_id, last_seen_at)
// comes from metadata.Monitors, which outlives engine restarts.

package rest

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
	"github.com/charlses/clearvoiance/engine/internal/sessions"
	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

// ControlPusher is the narrow slice of the gRPC ControlServer that the
// REST handlers need. Kept as an interface so this package doesn't
// import the grpc package (preventing an import cycle and keeping the
// REST surface testable with a fake pusher).
type ControlPusher interface {
	PushStart(clientName string, cmd *pb.StartCapture) int
	PushStop(clientName string, cmd *pb.StopCapture) int
	OnlineCount(clientName string) int
	OnlineClients() map[string]int
}

func mountMonitors(r chi.Router, d Deps) {
	if d.MetaStore == nil {
		return
	}
	h := &monitorsHandler{
		monitors: d.MetaStore.Monitors(),
		mgr:      d.SessionMgr,
		control:  d.ControlPusher,
	}
	r.Route("/monitors", func(r chi.Router) {
		r.Get("/", h.list)
		r.Get("/{name}", h.get)
		r.Post("/{name}/start", h.start)
		r.Post("/{name}/stop", h.stop)
	})
}

type monitorsHandler struct {
	monitors metadata.Monitors
	mgr      *sessions.Manager
	control  ControlPusher
}

type monitorView struct {
	Name            string            `json:"name"`
	DisplayName     string            `json:"display_name"`
	Labels          map[string]string `json:"labels"`
	CaptureEnabled  bool              `json:"capture_enabled"`
	ActiveSessionID *string           `json:"active_session_id,omitempty"`
	SDKLanguage     string            `json:"sdk_language,omitempty"`
	SDKVersion      string            `json:"sdk_version,omitempty"`
	LastSeenAt      string            `json:"last_seen_at"`
	CreatedAt       string            `json:"created_at"`
	// Runtime-only: filled from the in-memory gRPC stream registry.
	// Zero = SDK is not currently connected.
	OnlineReplicas int `json:"online_replicas"`
	Online         bool `json:"online"`
}

func (h *monitorsHandler) toView(row metadata.MonitorRow) monitorView {
	online := 0
	if h.control != nil {
		online = h.control.OnlineCount(row.Name)
	}
	labels := row.Labels
	if labels == nil {
		labels = map[string]string{}
	}
	return monitorView{
		Name:            row.Name,
		DisplayName:     row.DisplayName,
		Labels:          labels,
		CaptureEnabled:  row.CaptureEnabled,
		ActiveSessionID: row.ActiveSessionID,
		SDKLanguage:     row.SDKLanguage,
		SDKVersion:      row.SDKVersion,
		LastSeenAt:      row.LastSeenAt.Format(time.RFC3339),
		CreatedAt:       row.CreatedAt.Format(time.RFC3339),
		OnlineReplicas:  online,
		Online:          online > 0,
	}
}

// --- GET /monitors ----------------------------------------------------

func (h *monitorsHandler) list(w http.ResponseWriter, r *http.Request) {
	rows, err := h.monitors.List(r.Context())
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"list monitors: "+err.Error(), nil)
		return
	}
	views := make([]monitorView, 0, len(rows))
	for _, row := range rows {
		views = append(views, h.toView(row))
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"monitors": views,
		"count":    len(views),
	})
}

// --- GET /monitors/{name} --------------------------------------------

func (h *monitorsHandler) get(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	row, err := h.monitors.Get(r.Context(), name)
	if err != nil {
		if errors.Is(err, metadata.ErrMonitorNotFound) {
			WriteError(w, http.StatusNotFound, "MONITOR_NOT_FOUND",
				"monitor "+name+" not found", nil)
			return
		}
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"get monitor: "+err.Error(), nil)
		return
	}
	WriteJSON(w, http.StatusOK, h.toView(*row))
}

// --- POST /monitors/{name}/start -------------------------------------

type startMonitorRequest struct {
	// Optional: session name override. Default: "<monitor>-<timestamp>".
	SessionName string `json:"session_name"`
	// Optional: extra labels merged on top of the monitor's labels.
	SessionLabels map[string]string `json:"session_labels"`
	// Optional: advisory flush timeout the SDK honors on the next Stop.
	FlushTimeoutMs int64 `json:"flush_timeout_ms"`
}

type startMonitorResponse struct {
	MonitorName     string `json:"monitor_name"`
	SessionID       string `json:"session_id"`
	SessionName     string `json:"session_name"`
	PushedToOnline  int    `json:"pushed_to_online"`
	Note            string `json:"note,omitempty"`
}

func (h *monitorsHandler) start(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	var req startMonitorRequest
	// ReadJSON is permissive with empty bodies; treat "no body" as "use
	// all defaults". Decoder errors on a malformed body get written by
	// ReadJSON itself.
	if r.ContentLength > 0 {
		if !ReadJSON(w, r, &req) {
			return
		}
	}

	row, err := h.monitors.Get(r.Context(), name)
	if err != nil {
		if errors.Is(err, metadata.ErrMonitorNotFound) {
			WriteError(w, http.StatusNotFound, "MONITOR_NOT_FOUND",
				"monitor "+name+" not registered — the SDK needs to subscribe first", nil)
			return
		}
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"get monitor: "+err.Error(), nil)
		return
	}
	if row.CaptureEnabled {
		WriteError(w, http.StatusConflict, "CAPTURE_ALREADY_ACTIVE",
			"monitor "+name+" already has an active capture — stop it first", map[string]any{
				"active_session_id": row.ActiveSessionID,
			})
		return
	}

	sessionName := strings.TrimSpace(req.SessionName)
	if sessionName == "" {
		sessionName = fmt.Sprintf("%s-%s",
			name, time.Now().UTC().Format("20060102-150405"))
	}
	labels := mergeLabels(row.Labels, req.SessionLabels)

	// Pre-create the session; push its id down the control stream so
	// the SDK attaches rather than minting a second one.
	sess, err := h.mgr.Start(r.Context(), sessions.StartRequest{
		Name:   sessionName,
		Labels: labels,
	})
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"create session: "+err.Error(), nil)
		return
	}

	// Flip capture state in the monitor row. Persisting BEFORE we push
	// so that if the push races with a reconnect, the resume path
	// picks up the new session.
	if err := h.monitors.SetCaptureState(r.Context(), name, true, &sess.ID); err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"set capture state: "+err.Error(), nil)
		return
	}

	reached := 0
	note := ""
	if h.control != nil {
		reached = h.control.PushStart(name, &pb.StartCapture{
			SessionId:     sess.ID,
			SessionName:   sessionName,
			SessionLabels: labels,
		})
	}
	if reached == 0 {
		// SDK is offline — the session is created and flagged, but
		// nothing's streaming yet. When the SDK reconnects, the
		// resume path in control.go will push StartCapture for it.
		note = "monitor is offline — session will start when the SDK reconnects"
	}
	WriteJSON(w, http.StatusAccepted, startMonitorResponse{
		MonitorName:    name,
		SessionID:      sess.ID,
		SessionName:    sessionName,
		PushedToOnline: reached,
		Note:           note,
	})
}

// --- POST /monitors/{name}/stop --------------------------------------

type stopMonitorResponse struct {
	MonitorName    string `json:"monitor_name"`
	SessionID      string `json:"session_id"`
	PushedToOnline int    `json:"pushed_to_online"`
	Note           string `json:"note,omitempty"`
}

func (h *monitorsHandler) stop(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	row, err := h.monitors.Get(r.Context(), name)
	if err != nil {
		if errors.Is(err, metadata.ErrMonitorNotFound) {
			WriteError(w, http.StatusNotFound, "MONITOR_NOT_FOUND",
				"monitor "+name+" not found", nil)
			return
		}
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"get monitor: "+err.Error(), nil)
		return
	}
	if !row.CaptureEnabled || row.ActiveSessionID == nil {
		WriteError(w, http.StatusConflict, "CAPTURE_NOT_ACTIVE",
			"monitor "+name+" has no active capture to stop", nil)
		return
	}
	sessionID := *row.ActiveSessionID

	// Clear the monitor's capture state first so a late reconnect
	// doesn't auto-resume.
	if err := h.monitors.SetCaptureState(r.Context(), name, false, nil); err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"set capture state: "+err.Error(), nil)
		return
	}

	// Try to stop the session on the engine side. If the SDK is still
	// online it'll also ACK its own stop; either way the session ends
	// up stopped.
	if _, stopErr := h.mgr.Stop(r.Context(), sessionID); stopErr != nil {
		// ErrAlreadyStopped is fine — SDK may have beaten us to it.
		if !errors.Is(stopErr, sessions.ErrAlreadyStopped) &&
			!errors.Is(stopErr, sessions.ErrNotFound) {
			// Surface non-trivial errors but don't undo the capture
			// flag change — that'd leave the UI in a worse state.
			WriteError(w, http.StatusInternalServerError, "INTERNAL",
				"stop session: "+stopErr.Error(), map[string]any{
					"session_id": sessionID,
				})
			return
		}
	}

	reached := 0
	note := ""
	if h.control != nil {
		reached = h.control.PushStop(name, &pb.StopCapture{
			SessionId:      sessionID,
			FlushTimeoutMs: 10_000,
		})
	}
	if reached == 0 {
		note = "monitor is offline — event flow was already stopped"
	}
	WriteJSON(w, http.StatusOK, stopMonitorResponse{
		MonitorName:    name,
		SessionID:      sessionID,
		PushedToOnline: reached,
		Note:           note,
	})
}

// --- helpers ----------------------------------------------------------

// mergeLabels copies `base` then overlays `over`. Either side may be
// nil. The caller always gets a non-nil map back for consistent JSON.
func mergeLabels(base, over map[string]string) map[string]string {
	out := make(map[string]string, len(base)+len(over))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range over {
		out[k] = v
	}
	return out
}
