package replay

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
)

func synthEvent(id string, ts int64) *pb.Event {
	return &pb.Event{
		Id:          id,
		SessionId:   "sess_w",
		TimestampNs: ts,
		Adapter:     "test",
		Payload:     &pb.Event_Http{Http: &pb.HttpEvent{Method: "GET", Path: "/x"}},
	}
}

func runWindowed(t *testing.T, events []*pb.Event, cfg Config) (*stubSink, time.Duration) {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	sink := &stubSink{}
	replays := &stubReplays{}
	eng := NewEngine(log, stubSource{events: events}, sink, replays, nil, stubDispatcher{})

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	start := time.Now()
	require.NoError(t, eng.Run(ctx, cfg))
	return sink, time.Since(start)
}

func TestWindow_FiltersEventsOutsideRange(t *testing.T) {
	// 5 events at 0, 100ms, 200ms, 300ms, 400ms from session start.
	base := time.Now().UnixNano()
	events := []*pb.Event{
		synthEvent("a", base),
		synthEvent("b", base+int64(100*time.Millisecond)),
		synthEvent("c", base+int64(200*time.Millisecond)),
		synthEvent("d", base+int64(300*time.Millisecond)),
		synthEvent("e", base+int64(400*time.Millisecond)),
	}

	// Window [150ms, 350ms] should keep c + d (offsets 200ms + 300ms).
	sink, _ := runWindowed(t, events, Config{
		ReplayID:        "rep_w1",
		SourceSessionID: "sess_w",
		TargetURL:       "http://unused",
		Speedup:         100.0, // fast so test doesn't hang
		WindowStartNs:   int64(150 * time.Millisecond),
		WindowEndNs:     int64(350 * time.Millisecond),
	})
	require.Equal(t, 2, sink.n, "window should select exactly 2 events")
}

func TestWindow_EndZeroMeansOpenEnded(t *testing.T) {
	base := time.Now().UnixNano()
	events := []*pb.Event{
		synthEvent("a", base),
		synthEvent("b", base+int64(100*time.Millisecond)),
		synthEvent("c", base+int64(500*time.Millisecond)),
	}
	sink, _ := runWindowed(t, events, Config{
		ReplayID:        "rep_w2",
		SourceSessionID: "sess_w",
		TargetURL:       "http://unused",
		Speedup:         100.0,
		WindowStartNs:   int64(50 * time.Millisecond),
		// WindowEndNs = 0 → through end
	})
	require.Equal(t, 2, sink.n, "open-ended window should include b + c")
}

func TestWindow_TargetDurationDerivesSpeedup(t *testing.T) {
	// 100ms-wide session (3 events).
	base := time.Now().UnixNano()
	events := []*pb.Event{
		synthEvent("a", base),
		synthEvent("b", base+int64(50*time.Millisecond)),
		synthEvent("c", base+int64(100*time.Millisecond)),
	}
	// TargetDurationMs = 10 → speedup = 100ms / 10ms = 10 → wall duration ≈10ms
	sink, wall := runWindowed(t, events, Config{
		ReplayID:         "rep_w3",
		SourceSessionID:  "sess_w",
		TargetURL:        "http://unused",
		TargetDurationMs: 10,
	})
	require.Equal(t, 3, sink.n)
	require.Greater(t, wall, 5*time.Millisecond, "didn't honor target duration; too fast")
	require.Less(t, wall, 200*time.Millisecond, "target duration took much longer than 10ms")
}

func TestWindow_EmptyFilterIsNotAnError(t *testing.T) {
	base := time.Now().UnixNano()
	events := []*pb.Event{synthEvent("a", base)}
	sink, _ := runWindowed(t, events, Config{
		ReplayID:        "rep_w4",
		SourceSessionID: "sess_w",
		TargetURL:       "http://unused",
		Speedup:         1.0,
		WindowStartNs:   int64(10 * time.Second),
		WindowEndNs:     int64(20 * time.Second),
	})
	require.Equal(t, 0, sink.n, "no events in window → zero dispatches + no error")
}
