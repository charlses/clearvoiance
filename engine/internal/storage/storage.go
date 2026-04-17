// Package storage defines the event-persistence boundary for the engine.
//
// Implementations live in sibling packages (memory, clickhouse). The CaptureServer
// acks a batch only once the configured store has persisted it, so an ack means
// "the engine has accepted responsibility for these events" — not "events are in
// RAM and may be dropped on crash."
package storage

import (
	"context"
	"errors"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
)

// ErrNotSupported is returned by Noop for ops that require a real backend.
var ErrNotSupported = errors.New("operation requires a real event store (set --clickhouse-dsn)")

// EventStore persists + reads captured events.
type EventStore interface {
	// InsertBatch writes events in order.
	InsertBatch(ctx context.Context, sessionID string, events []*pb.Event) error

	// ReadSession streams events for a session in chronological order. Used by
	// the replay engine. Both channels are always closed; the error channel
	// receives at most one error.
	ReadSession(ctx context.Context, sessionID string) (<-chan *pb.Event, <-chan error)

	// InsertReplayEvents writes per-event replay results. The row type lives in
	// the storage/clickhouse package to keep the schema there — callers pass
	// it via the ReplayResultRow alias below.
	InsertReplayEvents(ctx context.Context, rows []ReplayResultRow) error

	// Close releases any connections or background workers.
	Close() error
}

// ReplayResultRow is the flat shape written per dispatched event. Columns
// mirror the replay_events table in engine/internal/storage/clickhouse.
type ReplayResultRow struct {
	ReplayID           string
	EventID            string
	ScheduledFireNs    int64
	ActualFireNs       int64
	LagNs              int64
	ResponseStatus     uint16
	ResponseDurationNs int64
	ErrorCode          string
	ErrorMessage       string
	BytesSent          uint32
	BytesReceived      uint32
	HTTPMethod         string
	HTTPPath           string
	HTTPRoute          string
}

// Noop is the zero-cost store used when no persistence backend is configured.
type Noop struct{}

// InsertBatch returns nil.
func (Noop) InsertBatch(_ context.Context, _ string, _ []*pb.Event) error { return nil }

// ReadSession returns already-closed empty channels. Good enough for dev
// smoke where replay isn't exercised.
func (Noop) ReadSession(_ context.Context, _ string) (<-chan *pb.Event, <-chan error) {
	events := make(chan *pb.Event)
	errs := make(chan error, 1)
	close(events)
	errs <- ErrNotSupported
	close(errs)
	return events, errs
}

// InsertReplayEvents errors so replay fails fast when the operator forgot the DSN.
func (Noop) InsertReplayEvents(_ context.Context, _ []ReplayResultRow) error {
	return ErrNotSupported
}

// Close returns nil.
func (Noop) Close() error { return nil }
