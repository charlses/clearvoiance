// Package grpc hosts the gRPC-facing adapters that speak the clearvoiance wire
// protocol. See plan/04-protocol-spec.md for full semantics.
package grpc

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
	"github.com/charlses/clearvoiance/engine/internal/sessions"
	"github.com/charlses/clearvoiance/engine/internal/storage"
)

// serverVersion is stamped into HandshakeAck; filled by the caller.
const (
	defaultMaxBatchSize       int32 = 100
	defaultMaxEventsPerSecond int32 = 10_000
	defaultFlushIntervalMs    int64 = 100
)

// CaptureServer implements pb.CaptureServiceServer. The session manager tracks
// lifecycle + counters; the store persists event batches before they are acked.
type CaptureServer struct {
	pb.UnimplementedCaptureServiceServer

	log     *slog.Logger
	version string
	mgr     *sessions.Manager
	store   storage.EventStore
}

// NewCaptureServer wires a CaptureServer against a session manager and an
// EventStore. Pass storage.Noop{} for in-memory dev smoke tests.
func NewCaptureServer(log *slog.Logger, version string, mgr *sessions.Manager, store storage.EventStore) *CaptureServer {
	return &CaptureServer{log: log, version: version, mgr: mgr, store: store}
}

// StartSession opens a new capture window.
// Auth is a Phase 1b concern — for now any caller succeeds.
func (s *CaptureServer) StartSession(_ context.Context, req *pb.StartSessionRequest) (*pb.StartSessionResponse, error) {
	if req.GetName() == "" {
		return nil, status.Error(codes.InvalidArgument, "session name is required")
	}

	sess := s.mgr.Start(sessions.StartRequest{
		Name:   req.GetName(),
		Labels: req.GetLabels(),
	})

	s.log.Info("session started",
		"session_id", sess.ID,
		"name", sess.Name,
	)

	return &pb.StartSessionResponse{
		SessionId:   sess.ID,
		StartedAtNs: sess.StartedAt.UnixNano(),
	}, nil
}

// StopSession closes a session and returns captured totals.
func (s *CaptureServer) StopSession(_ context.Context, req *pb.StopSessionRequest) (*pb.StopSessionResponse, error) {
	sess, err := s.mgr.Stop(req.GetSessionId())
	if err != nil {
		return nil, translateSessionErr(err)
	}

	s.log.Info("session stopped",
		"session_id", sess.ID,
		"events_captured", sess.EventsCaptured.Load(),
		"bytes_captured", sess.BytesCaptured.Load(),
	)

	return &pb.StopSessionResponse{
		StoppedAtNs:     sess.StoppedAt.UnixNano(),
		EventsCaptured:  sess.EventsCaptured.Load(),
		BytesCaptured:   sess.BytesCaptured.Load(),
	}, nil
}

// Heartbeat echoes session status. Backpressure is not emitted in Phase 1a.
func (s *CaptureServer) Heartbeat(_ context.Context, req *pb.HeartbeatRequest) (*pb.HeartbeatResponse, error) {
	sess, err := s.mgr.Get(req.GetSessionId())
	if err != nil {
		return nil, translateSessionErr(err)
	}
	return &pb.HeartbeatResponse{
		SessionActive: sess.Status == sessions.StatusActive,
	}, nil
}

// StreamEvents accepts a client-streaming pipe of event batches.
// First message on the stream must be a Handshake; subsequent messages
// carry batches. Every batch receives a matching BatchAck.
func (s *CaptureServer) StreamEvents(stream pb.CaptureService_StreamEventsServer) error {
	first, err := stream.Recv()
	if err != nil {
		return status.Error(codes.InvalidArgument, "stream closed before handshake")
	}
	hs := first.GetHandshake()
	if hs == nil {
		return status.Error(codes.InvalidArgument, "first message must be a Handshake")
	}

	sess, err := s.mgr.Get(hs.GetSessionId())
	if err != nil {
		return translateSessionErr(err)
	}
	if sess.Status != sessions.StatusActive {
		return status.Error(codes.FailedPrecondition, "session is not active")
	}

	s.log.Info("stream opened",
		"session_id", sess.ID,
		"sdk_version", hs.GetSdkVersion(),
	)

	if err := stream.Send(&pb.StreamEventsResponse{
		Msg: &pb.StreamEventsResponse_Ack{
			Ack: &pb.HandshakeAck{
				ServerVersion:               s.version,
				MaxBatchSize:                defaultMaxBatchSize,
				MaxEventsPerSecond:          defaultMaxEventsPerSecond,
				RecommendedFlushIntervalMs:  defaultFlushIntervalMs,
			},
		},
	}); err != nil {
		return err
	}

	for {
		msg, err := stream.Recv()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}

		switch payload := msg.GetMsg().(type) {
		case *pb.StreamEventsRequest_Batch:
			batch := payload.Batch
			if batch == nil {
				continue
			}
			events := batch.GetEvents()
			var bytes int64
			for _, ev := range events {
				bytes += int64(proto.Size(ev))
			}

			// Persist BEFORE acking. An ack means "we've accepted responsibility for
			// these events"; acking before write-through would let a crash lose them.
			if err := s.store.InsertBatch(stream.Context(), sess.ID, events); err != nil {
				s.log.Error("batch insert failed",
					"session_id", sess.ID,
					"batch_id", batch.GetBatchId(),
					"events", len(events),
					"err", err,
				)
				return status.Errorf(codes.Unavailable, "store insert failed: %v", err)
			}

			s.mgr.RecordEvents(sess.ID, int64(len(events)), bytes)

			s.log.Debug("batch persisted",
				"session_id", sess.ID,
				"batch_id", batch.GetBatchId(),
				"events", len(events),
				"bytes", bytes,
			)

			ackErr := stream.Send(&pb.StreamEventsResponse{
				Msg: &pb.StreamEventsResponse_BatchAck{
					BatchAck: &pb.BatchAck{
						BatchId:         batch.GetBatchId(),
						EventsPersisted: int32(len(events)),
					},
				},
			})
			if ackErr != nil {
				return ackErr
			}

		case *pb.StreamEventsRequest_Flush:
			// Nothing to flush in Phase 1a (no persistence queue yet).
			continue

		default:
			return status.Errorf(codes.InvalidArgument,
				"unexpected message type %T after handshake", payload)
		}
	}
}

// translateSessionErr maps session-layer errors to gRPC status codes.
func translateSessionErr(err error) error {
	switch {
	case errors.Is(err, sessions.ErrNotFound):
		return status.Error(codes.NotFound, "session not found")
	case errors.Is(err, sessions.ErrAlreadyStopped):
		return status.Error(codes.FailedPrecondition, "session already stopped")
	default:
		return status.Error(codes.Internal, fmt.Sprintf("session error: %v", err))
	}
}

// Deadline helper for future use (heartbeat timeouts, etc.).
var _ = time.Now
