package ws_test

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/require"

	"github.com/charlses/clearvoiance/engine/internal/api/ws"
	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

// The WS handler runs end-to-end here: real HTTP server, real websocket
// upgrade, real subscribe/publish round-trip. Uses Noop metadata (dev-open
// mode) so no Postgres is required.
func buildWSServer(t *testing.T) (*ws.Hub, *httptest.Server) {
	t.Helper()
	log := slog.New(slog.NewTextHandler(discardWriter{}, nil))
	hub := ws.NewHub(log)
	mux := http.NewServeMux()
	mux.Handle("/ws", ws.Handler(hub, metadata.Noop{}.APIKeys(), metadata.Noop{}.UserSessions()))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return hub, srv
}

func dialWS(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	wsURL := strings.Replace(url, "http://", "ws://", 1) + "/ws"
	conn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
	return conn
}

func sendJSON(t *testing.T, conn *websocket.Conn, msg map[string]any) {
	t.Helper()
	buf, err := json.Marshal(msg)
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	require.NoError(t, conn.Write(ctx, websocket.MessageText, buf))
}

func readJSON(t *testing.T, conn *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, data, err := conn.Read(ctx)
	require.NoError(t, err)
	var m map[string]any
	require.NoError(t, json.Unmarshal(data, &m))
	return m
}

func TestHub_AuthHandshakeRequired(t *testing.T) {
	_, srv := buildWSServer(t)

	wsURL := strings.Replace(srv.URL, "http://", "ws://", 1) + "/ws"
	conn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	require.NoError(t, err)
	// Send a non-auth first message — server should close the connection
	// with a policy-violation code.
	sendJSON(t, conn, map[string]any{"type": "subscribe", "topic": "replay.x.progress"})

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _, err = conn.Read(ctx)
	require.Error(t, err, "server must close the connection when first msg isn't auth")
}

func TestHub_SubscribeReceivesPublishedMessages(t *testing.T) {
	hub, srv := buildWSServer(t)
	conn := dialWS(t, srv.URL)

	// Auth handshake (dev-open: any non-empty key works with Noop meta).
	sendJSON(t, conn, map[string]any{"type": "auth", "api_key": "dev"})
	authAck := readJSON(t, conn)
	require.Equal(t, "message", authAck["type"])
	require.Equal(t, "__auth", authAck["topic"])

	// Subscribe.
	sendJSON(t, conn, map[string]any{
		"type":  "subscribe",
		"topic": "replay.rep_abc.progress",
	})
	subAck := readJSON(t, conn)
	require.Equal(t, "__subscribed", subAck["topic"])

	// Publish something — should arrive on the wire.
	delivered := hub.Publish("replay.rep_abc.progress", map[string]any{
		"events_dispatched": 42,
		"status":            "running",
	})
	require.Equal(t, 1, delivered)

	got := readJSON(t, conn)
	require.Equal(t, "message", got["type"])
	require.Equal(t, "replay.rep_abc.progress", got["topic"])
	data := got["data"].(map[string]any)
	require.Equal(t, float64(42), data["events_dispatched"])
	require.Equal(t, "running", data["status"])
}

func TestHub_UnsubscribeStopsDelivery(t *testing.T) {
	hub, srv := buildWSServer(t)
	conn := dialWS(t, srv.URL)

	sendJSON(t, conn, map[string]any{"type": "auth", "api_key": "dev"})
	_ = readJSON(t, conn) // auth ack

	sendJSON(t, conn, map[string]any{"type": "subscribe", "topic": "t1"})
	_ = readJSON(t, conn) // subscribe ack

	hub.Publish("t1", "first")
	first := readJSON(t, conn)
	require.Equal(t, "first", first["data"])

	sendJSON(t, conn, map[string]any{"type": "unsubscribe", "topic": "t1"})
	_ = readJSON(t, conn) // unsubscribe ack

	// After unsubscribe, the publish should reach 0 subscribers.
	require.Equal(t, 0, hub.Publish("t1", "dropped"))
}

func TestHub_PingPong(t *testing.T) {
	_, srv := buildWSServer(t)
	conn := dialWS(t, srv.URL)

	sendJSON(t, conn, map[string]any{"type": "auth", "api_key": "dev"})
	_ = readJSON(t, conn) // auth ack

	sendJSON(t, conn, map[string]any{"type": "ping"})
	pong := readJSON(t, conn)
	require.Equal(t, "__pong", pong["topic"])
}

// discardWriter swallows slog output so tests don't spam stderr.
type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) { return len(p), nil }
