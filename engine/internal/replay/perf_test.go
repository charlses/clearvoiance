package replay

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
	"github.com/charlses/clearvoiance/engine/internal/storage"
	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

// stubSource replays a precomputed slice of events.
type stubSource struct{ events []*pb.Event }

func (s stubSource) ReadSession(_ context.Context, _ string) (<-chan *pb.Event, <-chan error) {
	ch := make(chan *pb.Event, len(s.events))
	errs := make(chan error, 1)
	for _, e := range s.events {
		ch <- e
	}
	close(ch)
	close(errs)
	return ch, errs
}

// stubSink counts rows only.
type stubSink struct {
	mu sync.Mutex
	n  int
}

func (s *stubSink) InsertReplayEvents(_ context.Context, rows []storage.ReplayResultRow) error {
	s.mu.Lock()
	s.n += len(rows)
	s.mu.Unlock()
	return nil
}

// stubReplays: minimal in-memory Replays.
type stubReplays struct{ row *metadata.ReplayRow }

func (s *stubReplays) Create(_ context.Context, r metadata.ReplayRow) error {
	s.row = &r
	return nil
}
func (s *stubReplays) Get(_ context.Context, _ string) (*metadata.ReplayRow, error) {
	if s.row == nil {
		return nil, metadata.ErrReplayNotFound
	}
	return s.row, nil
}
func (s *stubReplays) MarkFinished(_ context.Context, _, status string, _ time.Time,
	_ metadata.ReplayMetrics, _ string) error {
	if s.row != nil {
		s.row.Status = status
	}
	return nil
}
func (s *stubReplays) List(_ context.Context, _ string, _ int) ([]metadata.ReplayRow, error) {
	if s.row == nil {
		return nil, nil
	}
	return []metadata.ReplayRow{*s.row}, nil
}

// stubDispatcher fires instantly — exercises the scheduler, not the wire.
type stubDispatcher struct{}

func (stubDispatcher) Name() string                         { return "stub" }
func (stubDispatcher) CanHandle(ev *pb.Event) bool          { return ev.GetHttp() != nil }
func (stubDispatcher) Dispatch(_ context.Context, ev *pb.Event, _ *TargetConfig, _ int) (DispatchResult, error) {
	return DispatchResult{ResponseStatus: 200, HTTPMethod: "GET"}, nil
}

// TestReplay_100xScheduler_LagBudget loads 1000 events with 10 ms spacing and
// replays at 100×, so the scheduler has to fire one every ~100 µs. The bench
// asserts max lag stays under 50 ms p99 (generous — CI hosts are noisy) but
// catches an obvious regression in the scheduler.
func TestReplay_100xScheduler_LagBudget(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping perf test in -short mode")
	}
	const n = 1000
	const spacingMs = 10
	const speedup = 100.0

	events := make([]*pb.Event, n)
	start := time.Now().UnixNano()
	for i := 0; i < n; i++ {
		events[i] = &pb.Event{
			Id:          "ev_perf",
			SessionId:   "sess_perf",
			TimestampNs: start + int64(i)*int64(spacingMs)*int64(time.Millisecond),
			Adapter:     "perf",
			Payload: &pb.Event_Http{Http: &pb.HttpEvent{
				Method: "GET", Path: "/x",
			}},
		}
	}

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	sink := &stubSink{}
	replays := &stubReplays{}
	eng := NewEngine(log, stubSource{events: events}, sink, replays, nil, stubDispatcher{})

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	replayStart := time.Now()
	require.NoError(t, eng.Run(ctx, Config{
		ReplayID:        "rep_perf",
		SourceSessionID: "sess_perf",
		TargetURL:       "http://unused",
		Speedup:         speedup,
	}))
	wallDuration := time.Since(replayStart)

	// Expected wall duration: total span / speedup = 999 * 10ms / 100 = ~99.9ms.
	// We give a generous envelope.
	expectedMin := 99 * time.Millisecond
	expectedMax := 2 * time.Second
	require.GreaterOrEqual(t, wallDuration, expectedMin,
		"replay completed suspiciously fast — scheduler may have skipped sleeps")
	require.LessOrEqual(t, wallDuration, expectedMax,
		"replay took longer than expected; scheduler cannot sustain 100x for tight events")

	sink.mu.Lock()
	require.Equal(t, n, sink.n, "not all events were dispatched")
	sink.mu.Unlock()
}
