package grpc

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
	"github.com/charlses/clearvoiance/engine/internal/replay"
	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

// ReplayServer implements pb.ReplayServiceServer. StartReplay kicks off a
// replay in a goroutine and returns immediately with the new replay id;
// operators poll GetReplay for progress / final metrics.
type ReplayServer struct {
	pb.UnimplementedReplayServiceServer

	log     *slog.Logger
	engine  *replay.Engine
	replays metadata.Replays
}

// NewReplayServer wires a ReplayServer against a replay.Engine + replays metadata.
func NewReplayServer(log *slog.Logger, eng *replay.Engine, replays metadata.Replays) *ReplayServer {
	return &ReplayServer{log: log, engine: eng, replays: replays}
}

// StartReplay kicks off a replay run in the background.
func (s *ReplayServer) StartReplay(ctx context.Context, req *pb.StartReplayRequest) (*pb.StartReplayResponse, error) {
	if req.GetSourceSessionId() == "" {
		return nil, status.Error(codes.InvalidArgument, "source_session_id is required")
	}
	if req.GetTargetUrl() == "" {
		return nil, status.Error(codes.InvalidArgument, "target_url is required")
	}
	if req.GetSpeedup() <= 0 && req.GetTargetDurationMs() <= 0 {
		return nil, status.Error(codes.InvalidArgument,
			"either speedup or target_duration_ms must be > 0")
	}

	cfg := replay.Config{
		ReplayID:         replay.NewReplayID(),
		SourceSessionID:  req.GetSourceSessionId(),
		TargetURL:        req.GetTargetUrl(),
		Speedup:          req.GetSpeedup(),
		Label:            req.GetLabel(),
		VirtualUsers:     int(req.GetVirtualUsers()),
		Auth:             replay.AuthFromProto(req.GetAuth()),
		Mutator:          replay.MutatorFromProto(req.GetMutator()),
		WindowStartNs:    req.GetWindowStartOffsetNs(),
		WindowEndNs:      req.GetWindowEndOffsetNs(),
		TargetDurationMs: req.GetTargetDurationMs(),
	}

	// Run in a background goroutine — don't block the RPC on the replay.
	// We use a detached context so a CLI client disconnecting doesn't cancel
	// the run. Phase 2b will add proper cancellation hooks.
	bgCtx := context.WithoutCancel(ctx)
	go func() {
		if err := s.engine.Run(bgCtx, cfg); err != nil {
			s.log.Error("replay failed",
				"replay_id", cfg.ReplayID,
				"err", err,
			)
		}
	}()

	// Return immediately with the assigned id. Engine.Run has written the
	// pending row synchronously before we get here? No — we kicked it off in
	// a goroutine, so Create() might race with Get(). Read-your-writes isn't
	// guaranteed. That's acceptable for v1; the CLI can retry Get().
	return &pb.StartReplayResponse{
		ReplayId:    cfg.ReplayID,
		StartedAtNs: nowNs(),
	}, nil
}

// GetReplay returns the current state + metrics for a replay.
func (s *ReplayServer) GetReplay(ctx context.Context, req *pb.GetReplayRequest) (*pb.GetReplayResponse, error) {
	row, err := s.replays.Get(ctx, req.GetReplayId())
	if err != nil {
		if errors.Is(err, metadata.ErrReplayNotFound) {
			return nil, status.Error(codes.NotFound, "replay not found")
		}
		return nil, status.Errorf(codes.Internal, "get replay: %v", err)
	}

	out := &pb.GetReplayResponse{
		ReplayId:         row.ID,
		SourceSessionId:  row.SourceSessionID,
		TargetUrl:        row.TargetURL,
		Speedup:          row.Speedup,
		Status:           row.Status,
		StartedAtNs:      row.StartedAt.UnixNano(),
		EventsDispatched: row.EventsDispatched,
		EventsFailed:     row.EventsFailed,
	}
	if row.FinishedAt != nil {
		out.FinishedAtNs = row.FinishedAt.UnixNano()
	}
	if row.P50LatencyMs != nil {
		out.P50LatencyMs = *row.P50LatencyMs
	}
	if row.P95LatencyMs != nil {
		out.P95LatencyMs = *row.P95LatencyMs
	}
	if row.P99LatencyMs != nil {
		out.P99LatencyMs = *row.P99LatencyMs
	}
	if row.MaxLagMs != nil {
		out.MaxLagMs = *row.MaxLagMs
	}
	return out, nil
}

// CancelReplay signals the background run to stop. The background run's
// terminal row lands with status="cancelled".
func (s *ReplayServer) CancelReplay(_ context.Context, req *pb.CancelReplayRequest) (*pb.CancelReplayResponse, error) {
	if req.GetReplayId() == "" {
		return nil, status.Error(codes.InvalidArgument, "replay_id is required")
	}
	if s.engine.Cancel(req.GetReplayId()) {
		return &pb.CancelReplayResponse{Status: "cancelling"}, nil
	}
	return &pb.CancelReplayResponse{Status: "not_running"}, nil
}

func nowNs() int64 { return time.Now().UnixNano() }
