package rest_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/charlses/clearvoiance/engine/internal/api/rest"
	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
	"github.com/charlses/clearvoiance/engine/internal/replay"
	"github.com/charlses/clearvoiance/engine/internal/sessions"
	"github.com/charlses/clearvoiance/engine/internal/storage"
	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

// fakePusher records pushes so tests can assert the right commands
// got sent to the SDK control stream.
type fakePusher struct {
	mu      sync.Mutex
	starts  []*pb.StartCapture
	stops   []*pb.StopCapture
	online  map[string]int
}

func (f *fakePusher) PushStart(name string, cmd *pb.StartCapture) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.starts = append(f.starts, cmd)
	if f.online == nil {
		return 0
	}
	return f.online[name]
}
func (f *fakePusher) PushStop(name string, cmd *pb.StopCapture) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stops = append(f.stops, cmd)
	if f.online == nil {
		return 0
	}
	return f.online[name]
}
func (f *fakePusher) OnlineCount(name string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.online == nil {
		return 0
	}
	return f.online[name]
}
func (f *fakePusher) OnlineClients() map[string]int {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]int{}
	for k, v := range f.online {
		out[k] = v
	}
	return out
}

// buildMonitorsServer is a slimmer fixture than buildServer — it wires
// the ControlPusher (which buildServer doesn't). Seeds a single test
// api key so Bearer auth works.
func buildMonitorsServer(t *testing.T) (*httptest.Server, *testMeta, *fakePusher) {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	meta := newTestMeta()
	require.NoError(t, meta.APIKeys().Create(context.Background(),
		"key_test0001", rest.HashAPIKey(testBearerKey), "test"))
	mgr := sessions.NewManager(meta.Sessions())
	re := replay.NewEngine(log, storage.Noop{}, storage.Noop{},
		meta.Replays(), nil)

	pusher := &fakePusher{online: map[string]int{}}
	srv := httptest.NewServer(rest.Router(rest.Deps{
		Log:           log,
		Version:       "test",
		SessionMgr:    mgr,
		EventStore:    storage.Noop{},
		MetaStore:     meta,
		ReplayEngine:  re,
		ControlPusher: pusher,
	}))
	t.Cleanup(srv.Close)
	return srv, meta, pusher
}

func TestMonitors_ListEmpty(t *testing.T) {
	srv, _, _ := buildMonitorsServer(t)
	code, body := doJSON(t, "GET", srv.URL+"/api/v1/monitors", nil, authHeaders())
	require.Equal(t, http.StatusOK, code)
	var got map[string]any
	require.NoError(t, json.Unmarshal(body, &got))
	require.Equal(t, float64(0), got["count"])
}

func TestMonitors_StartAgainstUnknown404s(t *testing.T) {
	srv, _, _ := buildMonitorsServer(t)
	code, body := doJSON(t, "POST", srv.URL+"/api/v1/monitors/ghost/start",
		map[string]any{}, authHeaders())
	require.Equal(t, http.StatusNotFound, code)
	require.Contains(t, string(body), "MONITOR_NOT_FOUND")
}

func TestMonitors_StartStopRoundtrip(t *testing.T) {
	srv, meta, pusher := buildMonitorsServer(t)

	// Seed a monitor as if the SDK had Subscribed.
	require.NoError(t, meta.Monitors().Upsert(context.Background(), metadata.MonitorRow{
		Name:        "coldfire-strapi",
		DisplayName: "ColdFire Strapi",
		Labels:      map[string]string{"env": "dev"},
		SDKLanguage: "node",
		SDKVersion:  "0.1.5",
	}))
	pusher.online["coldfire-strapi"] = 1 // pretend one replica online

	// Start.
	code, body := doJSON(t, "POST",
		srv.URL+"/api/v1/monitors/coldfire-strapi/start",
		map[string]any{"session_labels": map[string]any{"note": "smoke"}},
		authHeaders())
	require.Equal(t, http.StatusAccepted, code)

	var startResp map[string]any
	require.NoError(t, json.Unmarshal(body, &startResp))
	sessionID := startResp["session_id"].(string)
	require.NotEmpty(t, sessionID)
	require.EqualValues(t, 1, startResp["pushed_to_online"])

	// The pushed StartCapture should carry the pre-created session id
	// so the SDK can attach.
	require.Len(t, pusher.starts, 1)
	require.Equal(t, sessionID, pusher.starts[0].SessionId)
	// Merged labels: monitor's env=dev + session's note=smoke.
	require.Equal(t, "dev", pusher.starts[0].SessionLabels["env"])
	require.Equal(t, "smoke", pusher.starts[0].SessionLabels["note"])

	// Second Start while one is active → 409.
	code, body = doJSON(t, "POST",
		srv.URL+"/api/v1/monitors/coldfire-strapi/start",
		map[string]any{}, authHeaders())
	require.Equal(t, http.StatusConflict, code)
	require.Contains(t, string(body), "CAPTURE_ALREADY_ACTIVE")

	// Stop.
	code, body = doJSON(t, "POST",
		srv.URL+"/api/v1/monitors/coldfire-strapi/stop", nil, authHeaders())
	require.Equal(t, http.StatusOK, code)
	var stopResp map[string]any
	require.NoError(t, json.Unmarshal(body, &stopResp))
	require.Equal(t, sessionID, stopResp["session_id"])

	require.Len(t, pusher.stops, 1)
	require.Equal(t, sessionID, pusher.stops[0].SessionId)

	// Monitor row's capture state is cleared.
	row, err := meta.Monitors().Get(context.Background(), "coldfire-strapi")
	require.NoError(t, err)
	require.False(t, row.CaptureEnabled)
	require.Nil(t, row.ActiveSessionID)

	// Stop again → 409 CAPTURE_NOT_ACTIVE.
	code, _ = doJSON(t, "POST",
		srv.URL+"/api/v1/monitors/coldfire-strapi/stop", nil, authHeaders())
	require.Equal(t, http.StatusConflict, code)
}

func TestMonitors_StartWhileOffline(t *testing.T) {
	// When the SDK isn't connected, Start still pre-creates the session
	// and flips the capture flag — the SDK resumes on next Subscribe.
	srv, meta, _ := buildMonitorsServer(t)
	require.NoError(t, meta.Monitors().Upsert(context.Background(), metadata.MonitorRow{
		Name: "offline-svc",
	}))
	// pusher.online["offline-svc"] stays zero → PushStart returns 0

	code, body := doJSON(t, "POST",
		srv.URL+"/api/v1/monitors/offline-svc/start",
		map[string]any{}, authHeaders())
	require.Equal(t, http.StatusAccepted, code)
	var resp map[string]any
	require.NoError(t, json.Unmarshal(body, &resp))
	require.EqualValues(t, 0, resp["pushed_to_online"])
	require.Contains(t, resp["note"], "offline")

	// The row reflects the pending capture regardless.
	row, err := meta.Monitors().Get(context.Background(), "offline-svc")
	require.NoError(t, err)
	require.True(t, row.CaptureEnabled)
	require.NotNil(t, row.ActiveSessionID)
}
