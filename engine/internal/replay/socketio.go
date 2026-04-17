// Socket.IO v4 replay dispatcher.
//
// Keeps a per-(replay_id, captured_socket_id) WebSocket client to the target.
// Replays RECV_FROM_CLIENT packets as EVENT messages on the matching socket;
// EMIT_TO_CLIENT packets are not replayed (the target emits them organically
// in response to the RECV). CONNECT/DISCONNECT drive client lifecycle.

package replay

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
)

// SocketIODispatcher replays captured Socket.IO v4 traffic.
type SocketIODispatcher struct {
	log *slog.Logger

	mu      sync.Mutex
	clients map[string]*sioClient // key: capturedSocketID
}

// NewSocketIODispatcher constructs the dispatcher.
func NewSocketIODispatcher(log *slog.Logger) *SocketIODispatcher {
	return &SocketIODispatcher{
		log:     log,
		clients: make(map[string]*sioClient),
	}
}

// Name implements Dispatcher.
func (*SocketIODispatcher) Name() string { return "socket.io" }

// CanHandle implements Dispatcher.
func (*SocketIODispatcher) CanHandle(ev *pb.Event) bool {
	_, ok := ev.GetPayload().(*pb.Event_Socket)
	return ok
}

// Dispatch implements Dispatcher.
func (d *SocketIODispatcher) Dispatch(ctx context.Context, ev *pb.Event, target *TargetConfig, vu int) (DispatchResult, error) {
	sock := ev.GetSocket()
	if sock == nil {
		return DispatchResult{}, fmt.Errorf("socket dispatcher: event has no socket payload")
	}
	capID := sock.GetSocketId() + fmt.Sprintf(":vu%d", vu) // per-VU client

	switch sock.GetOp() {
	case pb.SocketEvent_SOCKET_OP_CONNECT:
		start := time.Now()
		client, err := d.openClient(ctx, target.BaseURL, sock.GetNamespace())
		if err != nil {
			return DispatchResult{
				ResponseDurationNs: time.Since(start).Nanoseconds(),
				ErrorCode:          "socket_connect",
				ErrorMessage:       err.Error(),
			}, nil
		}
		d.mu.Lock()
		d.clients[capID] = client
		d.mu.Unlock()
		return DispatchResult{
			ResponseStatus:     101, // WebSocket switching-protocols
			ResponseDurationNs: time.Since(start).Nanoseconds(),
		}, nil

	case pb.SocketEvent_SOCKET_OP_RECV_FROM_CLIENT:
		d.mu.Lock()
		client := d.clients[capID]
		d.mu.Unlock()
		if client == nil {
			return DispatchResult{
				ErrorCode:    "socket_no_client",
				ErrorMessage: "RECV without prior CONNECT for socket " + capID,
			}, nil
		}
		start := time.Now()
		args, _ := fetchBody(ctx, sock.GetData(), target.BlobReader)
		bytesSent, err := client.emitEvent(sock.GetNamespace(), sock.GetEventName(), args)
		if err != nil {
			return DispatchResult{
				ResponseDurationNs: time.Since(start).Nanoseconds(),
				ErrorCode:          "socket_emit",
				ErrorMessage:       err.Error(),
				BytesSent:          uint32(bytesSent),
			}, nil
		}
		return DispatchResult{
			ResponseDurationNs: time.Since(start).Nanoseconds(),
			BytesSent:          uint32(bytesSent),
		}, nil

	case pb.SocketEvent_SOCKET_OP_EMIT_TO_CLIENT:
		// Server-originated emit. We don't replay these — the target server
		// emits them on its own when it reacts to our RECV. Record a no-op
		// row so operators can correlate.
		return DispatchResult{ResponseStatus: 0, ErrorCode: "socket_skipped_emit"}, nil

	case pb.SocketEvent_SOCKET_OP_DISCONNECT:
		d.mu.Lock()
		client := d.clients[capID]
		delete(d.clients, capID)
		d.mu.Unlock()
		if client != nil {
			client.close()
		}
		return DispatchResult{ResponseStatus: 200}, nil
	}

	return DispatchResult{ErrorCode: "socket_unknown_op"}, nil
}

// --- Engine.IO v4 client --------------------------------------------------

type sioClient struct {
	conn      *websocket.Conn
	writeMu   sync.Mutex
	done      chan struct{}
	pingEvery time.Duration
}

func (d *SocketIODispatcher) openClient(ctx context.Context, baseURL, namespace string) (*sioClient, error) {
	u, err := url.Parse(baseURL)
	if err != nil {
		return nil, fmt.Errorf("parse base url: %w", err)
	}
	// http://host → ws://host
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/socket.io/"
	q := u.Query()
	q.Set("EIO", "4")
	q.Set("transport", "websocket")
	u.RawQuery = q.Encode()

	dialer := &websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}
	conn, _, err := dialer.DialContext(ctx, u.String(), http.Header{})
	if err != nil {
		return nil, fmt.Errorf("ws dial: %w", err)
	}

	// Expect Engine.IO OPEN (`0{json}`).
	_, msg, err := conn.ReadMessage()
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("read open: %w", err)
	}
	if len(msg) < 1 || msg[0] != '0' {
		conn.Close()
		return nil, fmt.Errorf("expected engine.io OPEN, got %q", string(msg))
	}
	var open struct {
		SID          string `json:"sid"`
		PingInterval int    `json:"pingInterval"`
	}
	if err := json.Unmarshal(msg[1:], &open); err != nil {
		conn.Close()
		return nil, fmt.Errorf("decode open: %w", err)
	}
	pingEvery := time.Duration(open.PingInterval) * time.Millisecond
	if pingEvery <= 0 {
		pingEvery = 25 * time.Second
	}

	// Socket.IO CONNECT (`40` for default namespace, `40/chat,` for named).
	nsp := namespace
	if nsp == "" {
		nsp = "/"
	}
	var connectPacket string
	if nsp == "/" {
		connectPacket = "40"
	} else {
		connectPacket = "40" + nsp + ","
	}
	if err := conn.WriteMessage(websocket.TextMessage, []byte(connectPacket)); err != nil {
		conn.Close()
		return nil, fmt.Errorf("write sio connect: %w", err)
	}

	// Expect Socket.IO CONNECT ack (`40{...}` for default, `40/chat,{...}` named).
	_, ack, err := conn.ReadMessage()
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("read sio connect ack: %w", err)
	}
	if !strings.HasPrefix(string(ack), "40") {
		conn.Close()
		return nil, fmt.Errorf("expected sio CONNECT ack, got %q", string(ack))
	}

	c := &sioClient{conn: conn, done: make(chan struct{}), pingEvery: pingEvery}
	go c.pumpReads()
	go c.pumpPings()
	return c, nil
}

// emitEvent sends a Socket.IO EVENT packet. `args` is the captured JSON args
// array (e.g. `["hello"]`) — we embed it into `42["event",...args]`.
func (c *sioClient) emitEvent(namespace, eventName string, args []byte) (int, error) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	// Build `42` + optional `/ns,` + JSON([event, ...args])
	var b strings.Builder
	b.WriteString("42")
	if namespace != "" && namespace != "/" {
		b.WriteString(namespace)
		b.WriteString(",")
	}

	// args is a JSON array of the emit() arguments (e.g. `["world"]`).
	// We want the final payload to be ["event", "world"]. So prepend eventName.
	var parsed []json.RawMessage
	if len(args) > 0 {
		if err := json.Unmarshal(args, &parsed); err != nil {
			// Not a JSON array — rare, ignore.
			parsed = nil
		}
	}
	final := make([]any, 0, 1+len(parsed))
	final = append(final, eventName)
	for _, p := range parsed {
		final = append(final, json.RawMessage(p))
	}
	encoded, err := json.Marshal(final)
	if err != nil {
		return 0, fmt.Errorf("marshal sio event: %w", err)
	}
	b.Write(encoded)

	payload := b.String()
	if err := c.conn.WriteMessage(websocket.TextMessage, []byte(payload)); err != nil {
		return len(payload), fmt.Errorf("write sio event: %w", err)
	}
	return len(payload), nil
}

func (c *sioClient) close() {
	select {
	case <-c.done:
		return
	default:
		close(c.done)
	}
	_ = c.conn.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, "bye"),
		time.Now().Add(time.Second))
	_ = c.conn.Close()
}

func (c *sioClient) pumpReads() {
	for {
		select {
		case <-c.done:
			return
		default:
		}
		_ = c.conn.SetReadDeadline(time.Now().Add(2 * c.pingEvery))
		_, msg, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		// Handle PING (`2`) → PONG (`3`). Ignore everything else (server
		// emits we purposely drop).
		if len(msg) > 0 && msg[0] == '2' {
			c.writeMu.Lock()
			_ = c.conn.WriteMessage(websocket.TextMessage, []byte("3"))
			c.writeMu.Unlock()
		}
	}
}

func (c *sioClient) pumpPings() {
	// Socket.IO v4 server drives pings; we only need to answer them. But
	// send an app-level ping (`2`) occasionally to catch broken connections
	// faster.
	ticker := time.NewTicker(c.pingEvery)
	defer ticker.Stop()
	for {
		select {
		case <-c.done:
			return
		case <-ticker.C:
			c.writeMu.Lock()
			err := c.conn.WriteMessage(websocket.TextMessage, []byte("2"))
			c.writeMu.Unlock()
			if err != nil {
				return
			}
		}
	}
}

// quoteString helper in case we ever need escape; kept for completeness.
var _ = strconv.Quote
