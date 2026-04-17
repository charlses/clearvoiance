package grpc

import (
	"context"
	"errors"
	"log/slog"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/charlses/clearvoiance/engine/internal/hermetic"
	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
	"github.com/charlses/clearvoiance/engine/internal/storage"
	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

// HermeticServer implements pb.HermeticServiceServer. On a GetMockPack call
// it scans the source session's ClickHouse events for outbound records and
// streams MockEntry rows back to the SDK, which indexes them by
// (caused_by_event_id, signature) on the client side.
type HermeticServer struct {
	pb.UnimplementedHermeticServiceServer

	log     *slog.Logger
	store   storage.EventStore
	apiKeys metadata.APIKeys
}

// NewHermeticServer wires the service against an EventStore + APIKeys source.
func NewHermeticServer(
	log *slog.Logger,
	store storage.EventStore,
	apiKeys metadata.APIKeys,
) *HermeticServer {
	return &HermeticServer{log: log, store: store, apiKeys: apiKeys}
}

// GetMockPack streams mock entries for a captured session.
func (s *HermeticServer) GetMockPack(
	req *pb.GetMockPackRequest,
	stream pb.HermeticService_GetMockPackServer,
) error {
	if err := s.auth(stream.Context(), req.GetApiKey()); err != nil {
		return err
	}
	sessionID := req.GetSourceSessionId()
	if sessionID == "" {
		return status.Error(codes.InvalidArgument, "source_session_id is required")
	}

	var emitted int
	err := hermetic.BuildMockPack(
		stream.Context(),
		s.store,
		sessionID,
		func(entry *pb.MockEntry) error {
			emitted++
			return stream.Send(entry)
		},
	)
	if err != nil {
		return status.Errorf(codes.Internal, "mockpack build: %v", err)
	}

	s.log.Info("mock pack streamed",
		"session_id", sessionID,
		"entries", emitted,
	)
	return nil
}

// auth mirrors CaptureServer's dev-open semantics: when no api_keys are
// provisioned, any non-empty key is accepted; once keys exist, the key must
// match a provisioned hash.
func (s *HermeticServer) auth(ctx context.Context, apiKey string) error {
	if apiKey == "" {
		return status.Error(codes.Unauthenticated, "api_key is required")
	}
	count, err := s.apiKeys.Count(ctx)
	if err != nil {
		// Fail open on transient metadata errors; matches capture/replay
		// behavior so a Postgres hiccup doesn't nuke an ongoing replay.
		s.log.Warn("hermetic: api-keys count failed, allowing through", "err", err)
		return nil
	}
	if count == 0 {
		return nil
	}
	if _, err := s.apiKeys.ValidateHash(ctx, HashAPIKey(apiKey)); err != nil {
		if errors.Is(err, metadata.ErrAPIKeyNotFound) {
			return status.Error(codes.Unauthenticated, "invalid api key")
		}
		return status.Errorf(codes.Internal, "validate api key: %v", err)
	}
	return nil
}
