// ControlService implements the dashboard-driven remote capture plane.
// SDKs open a long-running Subscribe stream at boot; the engine keeps
// an in-memory map of client_name → live streams and pushes
// StartCapture / StopCapture commands when operators toggle captures
// from the dashboard.
//
// The persistent side of this (monitor rows, last-seen, active
// session) lives in metadata.Monitors; this file is the runtime
// dispatcher. Horizontal replicas with the same client_name get each
// get their own stream in the map; commands fan out to all of them
// so a single capture session can span multiple instances.

package grpc

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

// pingInterval controls the server→client keepalive cadence on Subscribe
// streams. Short enough that LBs with short idle timeouts don't drop us,
// long enough that the chatter is negligible. Exported for tests.
const pingInterval = 15 * time.Second

// ControlServer implements pb.ControlServiceServer.
type ControlServer struct {
	pb.UnimplementedControlServiceServer

	log      *slog.Logger
	monitors metadata.Monitors
	apiKeys  metadata.APIKeys

	mu      sync.RWMutex
	streams map[string][]*controlStream // keyed by client_name
}

// NewControlServer wires a ControlServer against a Monitors store and
// the same APIKeys source that authenticates capture + hermetic.
func NewControlServer(
	log *slog.Logger,
	monitors metadata.Monitors,
	apiKeys metadata.APIKeys,
) *ControlServer {
	return &ControlServer{
		log:      log,
		monitors: monitors,
		apiKeys:  apiKeys,
		streams:  make(map[string][]*controlStream),
	}
}

// controlStream wraps a single live Subscribe stream so the dispatcher
// can push commands to it without blocking on a slow client. commands
// is a buffered channel; if the buffer fills the stream is considered
// unhealthy and gets force-closed so the SDK reconnects.
type controlStream struct {
	clientName string
	instanceID string
	commands   chan *pb.ControlCommand
	done       chan struct{} // closed when the stream exits
}

// Subscribe handles one SDK client's long-running registration.
// Returns only when the client disconnects or the server shuts down.
func (s *ControlServer) Subscribe(
	req *pb.SubscribeRequest,
	stream pb.ControlService_SubscribeServer,
) error {
	name := req.GetClientName()
	if name == "" {
		return status.Error(codes.InvalidArgument, "client_name is required")
	}

	// Persist (or refresh) the monitor row. Preserves capture state
	// across re-register so a reconnect mid-capture resumes the same
	// session.
	if err := s.monitors.Upsert(stream.Context(), metadata.MonitorRow{
		Name:        name,
		DisplayName: req.GetDisplayName(),
		Labels:      req.GetLabels(),
		SDKLanguage: req.GetSdkLanguage(),
		SDKVersion:  req.GetSdkVersion(),
	}); err != nil {
		s.log.Warn("monitor upsert failed — continuing",
			"client", name, "err", err)
		// Non-fatal: run without persistent registry rather than
		// refusing the SDK's connection.
	}

	cs := &controlStream{
		clientName: name,
		instanceID: req.GetInstanceId(),
		// Buffer: enough for a handful of queued commands without
		// requiring the writer to block. Too big and slow clients
		// delay shutdown; too small and bursts get dropped. 16 is
		// plenty for operator-driven start/stop.
		commands: make(chan *pb.ControlCommand, 16),
		done:     make(chan struct{}),
	}
	defer close(cs.done)

	s.addStream(cs)
	defer s.removeStream(cs)

	// If this monitor already has an active capture (SDK reconnecting
	// mid-stream), immediately push StartCapture so the SDK re-attaches
	// to its session.
	s.resumeIfActive(stream.Context(), cs)

	s.log.Info("monitor subscribed",
		"client", name,
		"instance", cs.instanceID,
		"sdk", req.GetSdkLanguage()+"@"+req.GetSdkVersion(),
	)

	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-stream.Context().Done():
			s.log.Info("monitor disconnected",
				"client", name, "instance", cs.instanceID)
			return nil
		case cmd, ok := <-cs.commands:
			if !ok {
				return status.Error(codes.Aborted, "control stream closed")
			}
			if err := stream.Send(cmd); err != nil {
				s.log.Warn("control send failed",
					"client", name, "err", err)
				return err
			}
		case tick := <-ticker.C:
			if err := stream.Send(&pb.ControlCommand{
				Cmd: &pb.ControlCommand_Ping{
					Ping: &pb.Ping{ServerTsMs: tick.UnixMilli()},
				},
			}); err != nil {
				return err
			}
			// Opportunistic heartbeat update so the dashboard's
			// last-seen column reflects that the SDK is alive.
			_ = s.monitors.TouchLastSeen(stream.Context(), name, tick.UTC())
		}
	}
}

// PushStart fans StartCapture out to every live stream for a
// client_name. Returns the count of streams reached (0 if the SDK
// isn't connected yet — the caller should handle that case).
func (s *ControlServer) PushStart(clientName string, cmd *pb.StartCapture) int {
	return s.pushAll(clientName, &pb.ControlCommand{
		Cmd: &pb.ControlCommand_Start{Start: cmd},
	})
}

// PushStop fans StopCapture out to every live stream for a client_name.
func (s *ControlServer) PushStop(clientName string, cmd *pb.StopCapture) int {
	return s.pushAll(clientName, &pb.ControlCommand{
		Cmd: &pb.ControlCommand_Stop{Stop: cmd},
	})
}

// OnlineCount reports how many live streams a client has. The
// dashboard uses this to show "online"/"offline" + replica counts.
func (s *ControlServer) OnlineCount(clientName string) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.streams[clientName])
}

// OnlineClients returns a snapshot of which client names have at
// least one live stream, and their replica counts.
func (s *ControlServer) OnlineClients() map[string]int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]int, len(s.streams))
	for k, v := range s.streams {
		out[k] = len(v)
	}
	return out
}

// --- internal -------------------------------------------------------

func (s *ControlServer) pushAll(clientName string, cmd *pb.ControlCommand) int {
	s.mu.RLock()
	streams := append([]*controlStream(nil), s.streams[clientName]...)
	s.mu.RUnlock()
	reached := 0
	for _, cs := range streams {
		select {
		case cs.commands <- cmd:
			reached++
		default:
			// Buffer full — drop and log. The SDK will reconnect on
			// the next failed Send and re-register.
			s.log.Warn("control buffer full, dropping command",
				"client", clientName, "instance", cs.instanceID)
		}
	}
	return reached
}

func (s *ControlServer) addStream(cs *controlStream) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.streams[cs.clientName] = append(s.streams[cs.clientName], cs)
}

func (s *ControlServer) removeStream(cs *controlStream) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.streams[cs.clientName]
	out := list[:0]
	for _, x := range list {
		if x != cs {
			out = append(out, x)
		}
	}
	if len(out) == 0 {
		delete(s.streams, cs.clientName)
	} else {
		s.streams[cs.clientName] = out
	}
}

// resumeIfActive pushes StartCapture on subscribe when the monitor's
// row says a session is already active. Covers the
// engine-restart-while-capturing + network-blip-reconnect cases.
func (s *ControlServer) resumeIfActive(ctx context.Context, cs *controlStream) {
	row, err := s.monitors.Get(ctx, cs.clientName)
	if err != nil || row == nil {
		return
	}
	if !row.CaptureEnabled || row.ActiveSessionID == nil || *row.ActiveSessionID == "" {
		return
	}
	s.log.Info("resuming capture on reconnect",
		"client", cs.clientName, "session", *row.ActiveSessionID)
	select {
	case cs.commands <- &pb.ControlCommand{
		Cmd: &pb.ControlCommand_Start{
			Start: &pb.StartCapture{
				SessionId:     *row.ActiveSessionID,
				SessionName:   row.DisplayName,
				SessionLabels: row.Labels,
			},
		},
	}:
	default:
		s.log.Warn("resume push dropped — buffer full")
	}
}
