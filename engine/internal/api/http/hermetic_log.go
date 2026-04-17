// Package http hosts the engine's plain-HTTP surface. The gRPC side handles
// the primary wire protocol; this module exposes a tiny HTTP mux for cases
// where gRPC is inconvenient — today only the hermetic unmocked-log endpoint.
package http

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
)

// UnmockedRecord mirrors the SDK's UnmockedInfo shape + session id so
// operators can answer "what outbound calls does this session need that I
// haven't captured yet?" from a grep-able log stream.
type UnmockedRecord struct {
	SourceSessionID string `json:"source_session_id"`
	Protocol        string `json:"protocol"`
	Method          string `json:"method"`
	Host            string `json:"host"`
	Path            string `json:"path"`
	EventID         string `json:"eventId"`
	Signature       string `json:"signature"`
}

// HermeticUnmockedHandler accepts POST /hermetic/unmocked and logs the
// record to the engine's slog stream at INFO level with a stable key set so
// log-based tooling can filter for "unmocked outbound" alerts.
func HermeticUnmockedHandler(log *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64*1024))
		if err != nil {
			http.Error(w, "body too large or unreadable", http.StatusBadRequest)
			return
		}
		var rec UnmockedRecord
		if err := json.Unmarshal(raw, &rec); err != nil {
			http.Error(w, "malformed json: "+err.Error(), http.StatusBadRequest)
			return
		}
		log.Info("unmocked outbound recorded",
			"source_session_id", rec.SourceSessionID,
			"event_id", rec.EventID,
			"method", rec.Method,
			"host", rec.Host,
			"path", rec.Path,
			"signature", rec.Signature,
		)
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}
}

// NewMux builds the engine's HTTP mux with every side-channel endpoint
// wired up. Caller owns the returned ServeMux.
func NewMux(log *slog.Logger) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("/hermetic/unmocked", HermeticUnmockedHandler(log))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok\n"))
	})
	return mux
}
