// Package replay runs a captured session against a target URL at a
// configurable speedup. Phase 2a ships the HTTP dispatcher; socket.io, cron,
// queue, auth strategies, and virtual-user mutators land in 2b.
package replay

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"sort"
	"sync"
	"time"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
	"github.com/charlses/clearvoiance/engine/internal/storage"
	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

// EventSource reads events for a session in order.
type EventSource interface {
	ReadSession(ctx context.Context, sessionID string) (<-chan *pb.Event, <-chan error)
}

// ResultSink writes per-event replay results.
type ResultSink interface {
	InsertReplayEvents(ctx context.Context, rows []storage.ReplayResultRow) error
}

// Dispatcher handles one protocol (http, socket.io, cron, …). Phase 2a shipped
// HTTP; future dispatchers register here without touching the scheduler.
type Dispatcher interface {
	Name() string
	// CanHandle reports whether this dispatcher wants the event.
	CanHandle(ev *pb.Event) bool
	// Dispatch fires the event against the target. vu is the virtual-user
	// index (0 for the original; 1..N-1 for fan-out replicas). Errors are for
	// transport-level failures; 5xx responses live in DispatchResult.
	Dispatch(ctx context.Context, ev *pb.Event, target *TargetConfig, vu int) (DispatchResult, error)
}

// TargetConfig is what a dispatcher needs to know about where/how to fire.
type TargetConfig struct {
	BaseURL string
	Auth    AuthStrategy
	Mutator Mutator
	// BlobReader rehydrates captured BlobRef bodies. nil = no blob backend;
	// BlobRef bodies will be skipped by the dispatcher with a "blob:skipped"
	// error row rather than sending an empty body.
	BlobReader BlobReader
}

// BlobReader is the minimal contract HTTP/Socket dispatchers need to fetch
// captured large bodies from object storage. Implemented by blob.Store.
type BlobReader interface {
	Get(ctx context.Context, bucket, key string) ([]byte, error)
}

// DispatchResult is the shape each dispatcher returns per event.
type DispatchResult struct {
	ResponseStatus     uint16
	ResponseDurationNs int64
	BytesSent          uint32
	BytesReceived      uint32
	ErrorCode          string
	ErrorMessage       string
	// Optional HTTP fields pulled onto replay_events columns for easy slicing.
	HTTPMethod string
	HTTPPath   string
	HTTPRoute  string
}

// Config configures a single replay run.
type Config struct {
	ReplayID        string
	SourceSessionID string
	TargetURL       string
	Speedup         float64
	Label           string
	// VirtualUsers = N fans each captured event out to N dispatches (vu=0..N-1)
	// at the scheduled time; vu=0 preserves the original payload.
	VirtualUsers int
	// Auth rewrites credentials before each dispatch. Defaults to AuthNone.
	Auth AuthStrategy
	// Mutator rewrites request bodies per VU. Defaults to MutatorNone.
	Mutator Mutator
	// Optional cap on how many dispatches run in parallel. 0 = unbounded.
	MaxConcurrency int

	// Optional time window (offsets from the first captured event, in ns).
	// WindowEndNs = 0 means "to the end of the session".
	WindowStartNs int64
	WindowEndNs   int64

	// When > 0, overrides Speedup such that the filtered window's wall-clock
	// replay takes approximately this long. Example: "replay the 1h window in
	// 5 minutes" → TargetDurationMs = 300_000.
	TargetDurationMs int64
}

// ProgressPublisher receives periodic progress snapshots during a replay.
// Wired to the WebSocket hub in serve.go so `replay.{id}.progress`
// subscribers see live updates. A no-op publisher is the zero value.
type ProgressPublisher interface {
	PublishReplayProgress(replayID string, snapshot ProgressSnapshot)
}

// ProgressSnapshot is one progress sample. ObservedAtNs is set by the
// publisher wrapper so all callers see a consistent clock.
type ProgressSnapshot struct {
	Status              string  `json:"status"`
	EventsDispatched    int64   `json:"events_dispatched"`
	EventsFailed        int64   `json:"events_failed"`
	EventsBackpressured int64   `json:"events_backpressured"`
	ObservedAtNs        int64   `json:"observed_at_ns"`
}

// Engine drives a replay end to end.
type Engine struct {
	log         *slog.Logger
	source      EventSource
	sink        ResultSink
	replays     metadata.Replays
	blobs       BlobReader
	dispatchers []Dispatcher
	publisher   ProgressPublisher

	// Running replays so CancelReplay can stop them.
	mu      sync.Mutex
	running map[string]context.CancelFunc
}

// NewEngine wires an Engine. Pass at least one Dispatcher (e.g. HTTPDispatcher).
// blobs may be nil; when nil, captured BlobRef bodies are skipped during replay.
func NewEngine(
	log *slog.Logger,
	source EventSource,
	sink ResultSink,
	replays metadata.Replays,
	blobs BlobReader,
	dispatchers ...Dispatcher,
) *Engine {
	return &Engine{
		log:         log,
		source:      source,
		sink:        sink,
		replays:     replays,
		blobs:       blobs,
		dispatchers: dispatchers,
		running:     make(map[string]context.CancelFunc),
	}
}

// SetProgressPublisher wires a publisher that receives periodic progress
// snapshots. Safe to call after NewEngine and before Run; setting it to
// nil disables publishing.
func (e *Engine) SetProgressPublisher(p ProgressPublisher) {
	e.publisher = p
}

// publishProgress is the single hook the scheduler loop calls. No-op when
// no publisher is configured.
func (e *Engine) publishProgress(replayID, status string, dispatched, failed, backpressured int64) {
	if e.publisher == nil {
		return
	}
	e.publisher.PublishReplayProgress(replayID, ProgressSnapshot{
		Status:              status,
		EventsDispatched:    dispatched,
		EventsFailed:        failed,
		EventsBackpressured: backpressured,
		ObservedAtNs:        time.Now().UnixNano(),
	})
}

// Cancel stops an in-flight replay run. Safe to call for unknown ids.
func (e *Engine) Cancel(replayID string) bool {
	e.mu.Lock()
	cancel, ok := e.running[replayID]
	e.mu.Unlock()
	if ok {
		cancel()
	}
	return ok
}

// NewReplayID generates a unique replay id.
func NewReplayID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		panic(err)
	}
	return "rep_" + hex.EncodeToString(buf[:])
}

// ErrNoDispatcher is returned when no dispatcher can handle an event.
var ErrNoDispatcher = errors.New("no dispatcher for event")

// Run executes a replay to completion. It:
//  1. inserts a 'running' row into the replays table
//  2. reads events from ClickHouse in ts order
//  3. schedules each event at t0 + (ev.offset / speedup)
//  4. dispatches via a worker pool
//  5. batches replay_events writes to ClickHouse
//  6. writes a terminal 'completed' / 'failed' row with summary metrics
func (e *Engine) Run(ctx context.Context, cfg Config) error {
	// Either an explicit speedup or a target duration must be given; the
	// scheduler picks whichever is present and falls back to 1x if neither.
	if cfg.Speedup <= 0 && cfg.TargetDurationMs <= 0 {
		return fmt.Errorf("speedup or target_duration_ms must be > 0")
	}
	startedAt := time.Now().UTC()

	// Record the input speedup; the actually-used (effective) speedup may be
	// derived from TargetDurationMs once we know the window size, but we
	// don't have that yet and Create() runs before the scheduler loop.
	speedupForRow := cfg.Speedup
	if speedupForRow <= 0 {
		speedupForRow = 1.0 // placeholder for target-duration mode
	}
	if err := e.replays.Create(ctx, metadata.ReplayRow{
		ID:              cfg.ReplayID,
		SourceSessionID: cfg.SourceSessionID,
		TargetURL:       cfg.TargetURL,
		Speedup:         speedupForRow,
		Label:           cfg.Label,
		Status:          "running",
		StartedAt:       startedAt,
	}); err != nil {
		return fmt.Errorf("create replay row: %w", err)
	}

	// Register for cancellation.
	runCtx, cancel := context.WithCancel(ctx)
	e.mu.Lock()
	e.running[cfg.ReplayID] = cancel
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		delete(e.running, cfg.ReplayID)
		e.mu.Unlock()
		cancel()
	}()

	summary, runErr := e.run(runCtx, cfg)
	finishedAt := time.Now().UTC()
	status := "completed"
	errMsg := ""
	if runErr != nil {
		if errors.Is(runErr, context.Canceled) {
			status = "cancelled"
			errMsg = ""
		} else {
			status = "failed"
			errMsg = runErr.Error()
		}
	}
	// Use the parent context for the final UPDATE so a canceled replay still
	// gets its terminal row written.
	if err := e.replays.MarkFinished(ctx, cfg.ReplayID, status, finishedAt,
		summary.metrics(), errMsg); err != nil {
		e.log.Error("mark replay finished", "err", err)
	}
	return runErr
}

// run orchestrates the scheduling + dispatching. Returns summary metrics.
func (e *Engine) run(ctx context.Context, cfg Config) (*summary, error) {
	events, errs := e.source.ReadSession(ctx, cfg.SourceSessionID)

	// Prebuffer all events so we can compute the offset baseline reliably.
	// For very large sessions we'll want a streaming scheduler; good enough
	// for Phase 2a (captures are typically < 100K events).
	buffered, err := drainEvents(events, errs)
	if err != nil {
		return &summary{}, fmt.Errorf("read events: %w", err)
	}
	if len(buffered) == 0 {
		e.log.Info("replay has no events", "replay_id", cfg.ReplayID)
		return &summary{}, nil
	}
	sort.SliceStable(buffered, func(i, j int) bool {
		return buffered[i].GetTimestampNs() < buffered[j].GetTimestampNs()
	})

	// Window filter: keep events whose offset from the session start falls
	// within [WindowStartNs, WindowEndNs]. WindowEndNs = 0 means open-ended.
	sessionStart := buffered[0].GetTimestampNs()
	if cfg.WindowStartNs > 0 || cfg.WindowEndNs > 0 {
		filtered := buffered[:0]
		for _, ev := range buffered {
			off := ev.GetTimestampNs() - sessionStart
			if off < cfg.WindowStartNs {
				continue
			}
			if cfg.WindowEndNs > 0 && off > cfg.WindowEndNs {
				continue
			}
			filtered = append(filtered, ev)
		}
		buffered = filtered
		if len(buffered) == 0 {
			e.log.Info("replay window selected zero events",
				"replay_id", cfg.ReplayID,
				"window_start_ns", cfg.WindowStartNs,
				"window_end_ns", cfg.WindowEndNs,
			)
			return &summary{}, nil
		}
	}

	// Effective speedup: if TargetDurationMs is set, compute so the filtered
	// window maps to approximately that wall-clock duration.
	effectiveSpeedup := cfg.Speedup
	if cfg.TargetDurationMs > 0 && len(buffered) > 1 {
		windowNs := buffered[len(buffered)-1].GetTimestampNs() - buffered[0].GetTimestampNs()
		if windowNs > 0 {
			effectiveSpeedup = float64(windowNs) / float64(cfg.TargetDurationMs*int64(time.Millisecond))
			e.log.Info("replay speedup derived from target duration",
				"replay_id", cfg.ReplayID,
				"window_ns", windowNs,
				"target_ms", cfg.TargetDurationMs,
				"speedup", effectiveSpeedup,
			)
		}
	}
	if effectiveSpeedup <= 0 {
		effectiveSpeedup = 1.0
	}

	baseTimestampNs := buffered[0].GetTimestampNs()
	replayStart := time.Now()

	auth := cfg.Auth
	if auth == nil {
		auth = AuthNone{}
	}
	mutator := cfg.Mutator
	if mutator == nil {
		mutator = MutatorNone{}
	}
	target := &TargetConfig{
		BaseURL:    cfg.TargetURL,
		Auth:       auth,
		Mutator:    mutator,
		BlobReader: e.blobs,
	}

	vuCount := cfg.VirtualUsers
	if vuCount < 1 {
		vuCount = 1
	}

	// Worker pool: bounded if MaxConcurrency > 0, else unbounded.
	var sem chan struct{}
	if cfg.MaxConcurrency > 0 {
		sem = make(chan struct{}, cfg.MaxConcurrency)
	}

	results := make(chan storage.ReplayResultRow, 1024)
	writerDone := make(chan error, 1)

	// Background writer: buffers results + flushes periodically.
	go func() {
		writerDone <- e.writeResults(ctx, cfg.ReplayID, results)
	}()

	var wg sync.WaitGroup
	sum := &summary{}

	// Periodic progress publisher. Runs alongside the scheduler loop and
	// pushes current counters to every WS subscriber of
	// replay.{id}.progress. Tick interval is 250ms per the plan; the
	// publisher's Publish() is non-blocking (drops on slow clients) so
	// this never back-pressures the scheduler.
	progressDone := make(chan struct{})
	if e.publisher != nil {
		go func() {
			defer close(progressDone)
			tick := time.NewTicker(250 * time.Millisecond)
			defer tick.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-tick.C:
					d, f, b := sum.snapshot()
					e.publishProgress(cfg.ReplayID, "running", d, f, b)
				}
			}
		}()
	} else {
		close(progressDone)
	}
	defer func() {
		<-progressDone
		// Final snapshot once everything settles so subscribers see the
		// terminal counters before the replay row lands.
		d, f, b := sum.snapshot()
		e.publishProgress(cfg.ReplayID, "finished", d, f, b)
	}()

	for _, ev := range buffered {
		// Compute wall-clock target fire time.
		offsetNs := ev.GetTimestampNs() - baseTimestampNs
		fireAt := replayStart.Add(time.Duration(float64(offsetNs) / effectiveSpeedup))
		sleep := time.Until(fireAt)
		if sleep > 0 {
			select {
			case <-time.After(sleep):
			case <-ctx.Done():
				close(results)
				wg.Wait()
				<-writerDone
				return sum, ctx.Err()
			}
		}
		actual := time.Now()
		lag := actual.Sub(fireAt)
		scheduledNs := fireAt.UnixNano()

		// Pick a dispatcher.
		dispatcher := e.dispatcherFor(ev)
		if dispatcher == nil {
			sum.recordSkipped()
			continue
		}

		// Fan out to virtual users. Each VU is an independent dispatch at the
		// same scheduled time. vu=0 preserves the captured payload.
		for vu := 0; vu < vuCount; vu++ {
			vuIdx := vu
			wg.Add(1)
			if sem != nil {
				// Non-blocking try first so we can record backpressure events
				// (where the worker pool is saturated and we had to wait).
				select {
				case sem <- struct{}{}:
				default:
					sum.recordBackpressured()
					sem <- struct{}{}
				}
			}
			go func(ev *pb.Event, vu int) {
				defer wg.Done()
				if sem != nil {
					defer func() { <-sem }()
				}
				res, derr := dispatcher.Dispatch(ctx, ev, target, vu)
				eventID := ev.GetId()
				if vu > 0 {
					eventID = fmt.Sprintf("%s:vu%d", eventID, vu)
				}
				row := storage.ReplayResultRow{
					ReplayID:           cfg.ReplayID,
					EventID:            eventID,
					ScheduledFireNs:    scheduledNs,
					ActualFireNs:       actual.UnixNano(),
					LagNs:              lag.Nanoseconds(),
					ResponseStatus:     res.ResponseStatus,
					ResponseDurationNs: res.ResponseDurationNs,
					ErrorCode:          res.ErrorCode,
					ErrorMessage:       res.ErrorMessage,
					BytesSent:          res.BytesSent,
					BytesReceived:      res.BytesReceived,
					HTTPMethod:         res.HTTPMethod,
					HTTPPath:           res.HTTPPath,
					HTTPRoute:          res.HTTPRoute,
				}
				if derr != nil {
					row.ErrorCode = "dispatch_error"
					row.ErrorMessage = derr.Error()
				}
				sum.record(row, derr != nil || res.ResponseStatus >= 500)
				select {
				case results <- row:
				case <-ctx.Done():
				}
			}(ev, vuIdx)
		}
	}

	wg.Wait()
	close(results)
	if err := <-writerDone; err != nil {
		return sum, fmt.Errorf("writer: %w", err)
	}
	return sum, nil
}

func (e *Engine) dispatcherFor(ev *pb.Event) Dispatcher {
	for _, d := range e.dispatchers {
		if d.CanHandle(ev) {
			return d
		}
	}
	return nil
}

// writeResults drains the results channel, batching writes to ClickHouse so
// we don't do one INSERT per event. Flushes every 128 rows or 500ms.
func (e *Engine) writeResults(ctx context.Context, _ string, ch <-chan storage.ReplayResultRow) error {
	const flushSize = 128
	flushInterval := 500 * time.Millisecond

	buf := make([]storage.ReplayResultRow, 0, flushSize)
	ticker := time.NewTicker(flushInterval)
	defer ticker.Stop()

	flush := func() error {
		if len(buf) == 0 {
			return nil
		}
		if err := e.sink.InsertReplayEvents(ctx, buf); err != nil {
			return err
		}
		buf = buf[:0]
		return nil
	}

	for {
		select {
		case row, ok := <-ch:
			if !ok {
				return flush()
			}
			buf = append(buf, row)
			if len(buf) >= flushSize {
				if err := flush(); err != nil {
					return err
				}
			}
		case <-ticker.C:
			if err := flush(); err != nil {
				return err
			}
		case <-ctx.Done():
			_ = flush()
			return ctx.Err()
		}
	}
}

func drainEvents(events <-chan *pb.Event, errs <-chan error) ([]*pb.Event, error) {
	var out []*pb.Event
	for ev := range events {
		out = append(out, ev)
	}
	if err := <-errs; err != nil {
		return nil, err
	}
	return out, nil
}

// summary tracks running numbers for a replay's terminal row.
type summary struct {
	mu                  sync.Mutex
	EventsDispatched    int64
	EventsFailed        int64
	EventsBackpressured int64
	latencies           []int64 // response_duration_ns
	maxLagNs            int64
}

func (s *summary) recordBackpressured() {
	s.mu.Lock()
	s.EventsBackpressured++
	s.mu.Unlock()
}

func (s *summary) record(row storage.ReplayResultRow, failed bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.EventsDispatched++
	if failed {
		s.EventsFailed++
	}
	s.latencies = append(s.latencies, row.ResponseDurationNs)
	if row.LagNs > s.maxLagNs {
		s.maxLagNs = row.LagNs
	}
}

func (s *summary) recordSkipped() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.EventsDispatched++
}

// snapshot returns the current counters for publisher use. Safe to call
// concurrently with record/recordBackpressured/recordSkipped.
func (s *summary) snapshot() (dispatched, failed, backpressured int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.EventsDispatched, s.EventsFailed, s.EventsBackpressured
}

func (s *summary) metrics() metadata.ReplayMetrics {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := metadata.ReplayMetrics{
		EventsDispatched:    s.EventsDispatched,
		EventsFailed:        s.EventsFailed,
		EventsBackpressured: s.EventsBackpressured,
	}
	if n := len(s.latencies); n > 0 {
		sorted := make([]int64, n)
		copy(sorted, s.latencies)
		sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
		p50 := float64(sorted[n*50/100]) / 1e6
		p95 := float64(sorted[int(math.Min(float64(n-1), float64(n*95/100)))]) / 1e6
		p99 := float64(sorted[int(math.Min(float64(n-1), float64(n*99/100)))]) / 1e6
		out.P50LatencyMs = &p50
		out.P95LatencyMs = &p95
		out.P99LatencyMs = &p99
	}
	if s.maxLagNs > 0 {
		maxLag := float64(s.maxLagNs) / 1e6
		out.MaxLagMs = &maxLag
	}
	return out
}

// helper for tests / other callers that want stdlib-based reqs without pulling
// http pkg.
var _ = http.DefaultClient
