package rest_test

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/charlses/clearvoiance/engine/internal/api/rest"
	"github.com/charlses/clearvoiance/engine/internal/replay"
	"github.com/charlses/clearvoiance/engine/internal/sessions"
	"github.com/charlses/clearvoiance/engine/internal/storage"
	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

// buildServer wires a REST router against an in-memory (Noop) metadata
// store. Good enough for happy/error-path coverage that doesn't depend on
// Postgres — the Postgres-specific paths (audit writer) have their own test.
func buildServer(t *testing.T) (*httptest.Server, metadata.Store) {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	meta := metadata.Noop{}
	mgr := sessions.NewManager(meta.Sessions())
	// Minimal replay engine so /replays endpoints don't NPE. A Noop
	// EventStore is fine — we don't actually run replays in these tests.
	re := replay.NewEngine(log, storage.Noop{}, storage.Noop{},
		meta.Replays(), nil)

	srv := httptest.NewServer(rest.Router(rest.Deps{
		Log:          log,
		Version:      "test",
		SessionMgr:   mgr,
		EventStore:   storage.Noop{},
		MetaStore:    meta,
		ReplayEngine: re,
	}))
	t.Cleanup(srv.Close)
	return srv, meta
}

func doJSON(t *testing.T, method, url string, body any, headers map[string]string) (int, []byte) {
	t.Helper()
	var buf io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		require.NoError(t, err)
		buf = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, url, buf)
	require.NoError(t, err)
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	out, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	return resp.StatusCode, out
}

func authHeaders() map[string]string {
	return map[string]string{"Authorization": "Bearer dev-key"}
}

func TestHealth_NoAuthRequired(t *testing.T) {
	srv, _ := buildServer(t)
	code, body := doJSON(t, "GET", srv.URL+"/api/v1/health", nil, nil)
	require.Equal(t, http.StatusOK, code)
	require.Contains(t, string(body), `"status":"ok"`)
}

func TestAuth_RejectsMissingBearer(t *testing.T) {
	srv, _ := buildServer(t)
	code, body := doJSON(t, "GET", srv.URL+"/api/v1/sessions", nil, nil)
	require.Equal(t, http.StatusUnauthorized, code)
	require.Contains(t, string(body), "UNAUTHENTICATED")
}

func TestAuth_DevOpenAcceptsAnyKeyWhenNoKeysProvisioned(t *testing.T) {
	srv, _ := buildServer(t)
	code, _ := doJSON(t, "GET", srv.URL+"/api/v1/sessions", nil, authHeaders())
	require.Equal(t, http.StatusOK, code)
}

func TestSessions_ListEmpty(t *testing.T) {
	srv, _ := buildServer(t)
	code, body := doJSON(t, "GET", srv.URL+"/api/v1/sessions", nil, authHeaders())
	require.Equal(t, http.StatusOK, code)
	var got map[string]any
	require.NoError(t, json.Unmarshal(body, &got))
	require.Equal(t, float64(0), got["count"])
}

func TestSessions_Get404ForUnknownId(t *testing.T) {
	srv, _ := buildServer(t)
	code, body := doJSON(t, "GET", srv.URL+"/api/v1/sessions/nope", nil, authHeaders())
	require.Equal(t, http.StatusNotFound, code)
	require.Contains(t, string(body), "SESSION_NOT_FOUND")
}

func TestReplays_Start_RejectsMissingFields(t *testing.T) {
	srv, _ := buildServer(t)
	code, body := doJSON(t, "POST", srv.URL+"/api/v1/replays",
		map[string]any{}, authHeaders())
	require.Equal(t, http.StatusBadRequest, code)
	require.Contains(t, string(body), "source_session_id is required")
}

func TestReplays_Start_Happy202(t *testing.T) {
	srv, _ := buildServer(t)
	code, body := doJSON(t, "POST", srv.URL+"/api/v1/replays",
		map[string]any{
			"source_session_id": "sess_x",
			"target_url":        "http://example.com",
			"speedup":           1.0,
		},
		authHeaders())
	require.Equal(t, http.StatusAccepted, code)
	var resp map[string]any
	require.NoError(t, json.Unmarshal(body, &resp))
	require.Contains(t, resp["id"].(string), "rep_")
	require.Equal(t, "pending", resp["status"])
}

func TestReplays_Get404ForUnknownId(t *testing.T) {
	srv, _ := buildServer(t)
	code, body := doJSON(t, "GET", srv.URL+"/api/v1/replays/nope", nil, authHeaders())
	require.Equal(t, http.StatusNotFound, code)
	require.Contains(t, string(body), "REPLAY_NOT_FOUND")
}

func TestReplays_CancelUnknown404(t *testing.T) {
	srv, _ := buildServer(t)
	code, _ := doJSON(t, "POST", srv.URL+"/api/v1/replays/rep_missing/cancel",
		nil, authHeaders())
	require.Equal(t, http.StatusNotFound, code)
}

func TestAPIKeys_CRUD_WithNoopReturnsFriendlyFailure(t *testing.T) {
	// Noop APIKeys.Create returns nil (no-op). The CRUD roundtrip proves
	// the handler plumbing is correct; Postgres wiring is covered by the
	// integration test.
	srv, _ := buildServer(t)
	code, body := doJSON(t, "POST", srv.URL+"/api/v1/api-keys",
		map[string]any{"name": "ci-dev"}, authHeaders())
	require.Equal(t, http.StatusCreated, code)
	var created map[string]any
	require.NoError(t, json.Unmarshal(body, &created))
	require.Contains(t, created["key"].(string), "clv_live_")
	require.NotEmpty(t, created["id"])
}

func TestAPIKeys_CreateRejectsEmptyName(t *testing.T) {
	srv, _ := buildServer(t)
	code, _ := doJSON(t, "POST", srv.URL+"/api/v1/api-keys",
		map[string]any{"name": ""}, authHeaders())
	require.Equal(t, http.StatusBadRequest, code)
}

func TestOpenAPI_ServesSpec(t *testing.T) {
	srv, _ := buildServer(t)
	resp, err := http.Get(srv.URL + "/api/v1/openapi.yaml")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	body, _ := io.ReadAll(resp.Body)
	require.Contains(t, string(body), "openapi: 3.1.0")
	require.Contains(t, string(body), "clearvoiance Control Plane")
}

func TestSwaggerUI_ServesHTML(t *testing.T) {
	srv, _ := buildServer(t)
	resp, err := http.Get(srv.URL + "/docs")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, "text/html; charset=utf-8", resp.Header.Get("content-type"))
}
