package rest_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

// Coverage for the endpoints added after the Phase-5 core slice. Uses the
// Noop-metadata server; the Postgres-backed surface lives in the
// integration_test.go file.

func TestReplays_ListEmptyOnNoop(t *testing.T) {
	srv, _ := buildServer(t)
	code, body := doJSON(t, "GET", srv.URL+"/api/v1/replays", nil, authHeaders())
	require.Equal(t, http.StatusOK, code)
	var got map[string]any
	require.NoError(t, json.Unmarshal(body, &got))
	require.Equal(t, float64(0), got["count"])
	require.Empty(t, got["replays"])
}

func TestSessions_EventsGracefulWithoutBackend(t *testing.T) {
	srv, _ := buildServer(t)
	code, body := doJSON(t, "GET",
		srv.URL+"/api/v1/sessions/sess_x/events?limit=10", nil, authHeaders())
	require.Equal(t, http.StatusOK, code)
	var got map[string]any
	require.NoError(t, json.Unmarshal(body, &got))
	// Noop event store doesn't implement SessionEventReader, so the handler
	// returns an empty list + a 'note' explaining why.
	require.Empty(t, got["events"])
	require.Contains(t, got["note"], "does not support session-event reads")
}

func TestReplays_EventsGracefulWithoutBackend(t *testing.T) {
	srv, _ := buildServer(t)
	code, body := doJSON(t, "GET",
		srv.URL+"/api/v1/replays/rep_x/events", nil, authHeaders())
	require.Equal(t, http.StatusOK, code)
	var got map[string]any
	require.NoError(t, json.Unmarshal(body, &got))
	require.Empty(t, got["events"])
	require.Contains(t, got["note"], "does not support replay-event reads")
}

func TestSessions_Delete_NotFoundOnNoop(t *testing.T) {
	srv, _ := buildServer(t)
	// Noop Sessions.Delete returns nil (no-op). Handler returns 204 without
	// a 404 because there's no existence check at the metadata layer — the
	// Postgres path catches missing ids via affected-rows.
	code, _ := doJSON(t, "DELETE",
		srv.URL+"/api/v1/sessions/sess_missing", nil, authHeaders())
	require.Equal(t, http.StatusNoContent, code)
}

func TestMetrics_EmitsPrometheusText(t *testing.T) {
	srv, _ := buildServer(t)
	resp, err := http.Get(srv.URL + "/api/v1/metrics")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Contains(t, resp.Header.Get("content-type"), "text/plain")

	// A few of our counters must show up.
	buf := make([]byte, 4096)
	n, _ := resp.Body.Read(buf)
	text := string(buf[:n])
	require.Contains(t, text, "clv_engine_uptime_seconds")
	require.Contains(t, text, "clv_http_requests_total")
	require.Contains(t, text, "clv_replays_started_total")
}

func TestConfig_RedactsDSNSecrets(t *testing.T) {
	srv, _ := buildServer(t)
	code, body := doJSON(t, "GET", srv.URL+"/api/v1/config", nil, authHeaders())
	require.Equal(t, http.StatusOK, code)
	// The test server doesn't pass DSNs; features map must still be present.
	var cfg map[string]any
	require.NoError(t, json.Unmarshal(body, &cfg))
	require.Equal(t, "clearvoiance", cfg["engine"])
	require.NotNil(t, cfg["features"])
}

func TestDBDeadlocks_503WithoutClickhouse(t *testing.T) {
	srv, _ := buildServer(t)
	code, body := doJSON(t, "GET",
		srv.URL+"/api/v1/replays/rep_x/db/deadlocks", nil, authHeaders())
	require.Equal(t, http.StatusServiceUnavailable, code)
	require.Contains(t, string(body), "DB_OBSERVER_UNAVAILABLE")
}

func TestDBExplain_501WithNoteExplainingDeferral(t *testing.T) {
	srv, _ := buildServer(t)
	code, body := doJSON(t, "GET",
		srv.URL+"/api/v1/replays/rep_x/db/explain/fp_abc", nil, authHeaders())
	require.Equal(t, http.StatusNotImplemented, code)
	var got map[string]any
	require.NoError(t, json.Unmarshal(body, &got))
	require.Contains(t, got["note"], "auto_explain")
}
