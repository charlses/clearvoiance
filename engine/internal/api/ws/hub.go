// Package ws implements the engine's live-view WebSocket API. Clients
// connect, auth with a Bearer api_key, and subscribe to topics like
// `replay.<id>.progress` to get push updates as state changes.
//
// See plan/15-phase-5-control-plane.md §WebSocket API.
package ws

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/charlses/clearvoiance/engine/internal/api/rest"
	"github.com/charlses/clearvoiance/engine/internal/replay"
	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

// Hub is the single-process broadcaster for topic subscriptions. Call
// Publish from anywhere in the engine to push a message to every client
// subscribed to that topic.
type Hub struct {
	log *slog.Logger

	mu          sync.RWMutex
	subscribers map[string]map[*client]struct{} // topic → set of clients
}

// NewHub constructs an empty hub.
func NewHub(log *slog.Logger) *Hub {
	return &Hub{
		log:         log,
		subscribers: make(map[string]map[*client]struct{}),
	}
}

// PublishReplayProgress satisfies replay.ProgressPublisher. The replay
// engine calls this on its progress ticker; we fan it out to every client
// subscribed to `replay.<id>.progress`.
func (h *Hub) PublishReplayProgress(replayID string, snapshot replay.ProgressSnapshot) {
	h.Publish("replay."+replayID+".progress", snapshot)
}

// Compile-time assertion that *Hub satisfies replay.ProgressPublisher so a
// breaking change in replay surfaces here rather than at serve.go wire-up.
var _ replay.ProgressPublisher = (*Hub)(nil)

// Publish sends a message to every client subscribed to `topic`. Returns
// the number of clients reached. Drops messages silently on slow clients
// — a per-topic dropped-count notice is sent to the affected client.
func (h *Hub) Publish(topic string, payload any) int {
	h.mu.RLock()
	subs := h.subscribers[topic]
	clients := make([]*client, 0, len(subs))
	for c := range subs {
		clients = append(clients, c)
	}
	h.mu.RUnlock()

	delivered := 0
	for _, c := range clients {
		if c.tryEnqueue(topic, payload) {
			delivered++
		}
	}
	return delivered
}

func (h *Hub) addSubscriber(topic string, c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set, ok := h.subscribers[topic]
	if !ok {
		set = make(map[*client]struct{})
		h.subscribers[topic] = set
	}
	set[c] = struct{}{}
}

func (h *Hub) removeSubscriber(topic string, c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if set, ok := h.subscribers[topic]; ok {
		delete(set, c)
		if len(set) == 0 {
			delete(h.subscribers, topic)
		}
	}
}

func (h *Hub) removeAll(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for t, set := range h.subscribers {
		delete(set, c)
		if len(set) == 0 {
			delete(h.subscribers, t)
		}
	}
}

// client is one connected websocket.
type client struct {
	conn      *websocket.Conn
	send      chan outgoing
	topics    map[string]struct{}
	dropped   map[string]int
	droppedMu sync.Mutex
}

type outgoing struct {
	Type    string `json:"type"`
	Topic   string `json:"topic,omitempty"`
	Data    any    `json:"data,omitempty"`
	Dropped int    `json:"dropped,omitempty"`
	Error   string `json:"error,omitempty"`
}

// tryEnqueue returns true if the message was enqueued; false if the client's
// buffer is full (in which case a drop notice is recorded).
func (c *client) tryEnqueue(topic string, payload any) bool {
	select {
	case c.send <- outgoing{Type: "message", Topic: topic, Data: payload}:
		return true
	default:
		c.droppedMu.Lock()
		c.dropped[topic]++
		c.droppedMu.Unlock()
		return false
	}
}

type incoming struct {
	Type   string `json:"type"`
	APIKey string `json:"api_key,omitempty"`
	Topic  string `json:"topic,omitempty"`
}

// Handler returns the http.HandlerFunc that upgrades a request to a
// websocket connection. Auth accepts either path:
//
//  1. Session cookie (clv_session) carried on the upgrade request — the
//     dashboard's default flow. When present + valid, auth is complete
//     before the upgrade; the client doesn't send an auth message.
//  2. In-protocol `{"type":"auth","api_key":"..."}` as the first message —
//     used by programmatic clients that don't have a session.
//
// Either way the server sends `{topic:"__auth", data:{ok:true}}` once
// auth is settled.
func Handler(h *Hub, keys metadata.APIKeys, sessions metadata.UserSessions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Resolve cookie auth BEFORE upgrading so we can skip the
		// in-protocol handshake on authed dashboards.
		cookieAuthOK := false
		if sessions != nil {
			if cookie, err := r.Cookie(rest.SessionCookieName); err == nil && cookie.Value != "" {
				if _, err := sessions.Lookup(r.Context(), rest.HashSessionToken(cookie.Value)); err == nil {
					cookieAuthOK = true
				}
			}
		}

		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			// OriginPatterns: ["*"] makes browser-side dev easy. For
			// production deploys, operators should front the engine with
			// a reverse proxy that enforces Origin.
			OriginPatterns: []string{"*"},
		})
		if err != nil {
			return
		}
		defer conn.CloseNow()

		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()

		c := &client{
			conn:    conn,
			send:    make(chan outgoing, 256),
			topics:  make(map[string]struct{}),
			dropped: make(map[string]int),
		}
		defer h.removeAll(c)

		if !cookieAuthOK {
			// --- In-protocol auth. First message must carry a valid api_key. ---
			authCtx, authCancel := context.WithTimeout(ctx, 5*time.Second)
			_, firstMsg, err := conn.Read(authCtx)
			authCancel()
			if err != nil {
				_ = conn.Close(websocket.StatusPolicyViolation, "auth timeout")
				return
			}
			var authMsg incoming
			if err := json.Unmarshal(firstMsg, &authMsg); err != nil || authMsg.Type != "auth" {
				_ = conn.Close(websocket.StatusPolicyViolation, "expected {type:auth}")
				return
			}
			if err := checkAPIKey(ctx, keys, authMsg.APIKey); err != nil {
				_ = conn.Close(websocket.StatusPolicyViolation, err.Error())
				return
			}
		}

		// Ack the auth (whether cookie-based or in-protocol).
		c.tryEnqueue("__auth", map[string]any{"ok": true})

		// --- Writer pump. ---
		go func() {
			ticker := time.NewTicker(10 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case msg := <-c.send:
					if err := writeJSON(ctx, conn, msg); err != nil {
						cancel()
						return
					}
				case <-ticker.C:
					c.flushDropNotices(ctx, conn)
				}
			}
		}()

		// --- Reader loop. ---
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var msg incoming
			if err := json.Unmarshal(data, &msg); err != nil {
				c.tryEnqueue("__error", map[string]any{
					"error": "could not decode: " + err.Error(),
				})
				continue
			}
			switch msg.Type {
			case "ping":
				c.tryEnqueue("__pong", nil)
			case "subscribe":
				if msg.Topic == "" {
					continue
				}
				c.topics[msg.Topic] = struct{}{}
				h.addSubscriber(msg.Topic, c)
				c.tryEnqueue("__subscribed", map[string]any{"topic": msg.Topic})
			case "unsubscribe":
				if msg.Topic == "" {
					continue
				}
				delete(c.topics, msg.Topic)
				h.removeSubscriber(msg.Topic, c)
				c.tryEnqueue("__unsubscribed", map[string]any{"topic": msg.Topic})
			}
		}
	}
}

func (c *client) flushDropNotices(ctx context.Context, conn *websocket.Conn) {
	c.droppedMu.Lock()
	defer c.droppedMu.Unlock()
	for topic, n := range c.dropped {
		_ = writeJSON(ctx, conn, outgoing{
			Type: "drop_notice", Topic: topic, Dropped: n,
		})
		delete(c.dropped, topic)
	}
}

func writeJSON(ctx context.Context, conn *websocket.Conn, msg outgoing) error {
	wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	buf, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return conn.Write(wctx, websocket.MessageText, buf)
}

// checkAPIKey validates an API key the same way the REST auth middleware
// does. Dev-open (count=0) accepts any non-empty key.
func checkAPIKey(ctx context.Context, keys metadata.APIKeys, apiKey string) error {
	if apiKey == "" {
		return errors.New("api_key required")
	}
	count, err := keys.Count(ctx)
	if err != nil {
		return nil // fail open on transient metadata errors (matches REST)
	}
	if count == 0 {
		return nil
	}
	if _, err := keys.ValidateHash(ctx, rest.HashAPIKey(apiKey)); err != nil {
		if errors.Is(err, metadata.ErrAPIKeyNotFound) {
			return errors.New("invalid api key")
		}
		return err
	}
	return nil
}
