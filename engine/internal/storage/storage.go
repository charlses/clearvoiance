// Package storage defines the event-persistence boundary for the engine.
//
// Implementations live in sibling packages (memory, clickhouse). The CaptureServer
// acks a batch only once the configured store has persisted it, so an ack means
// "the engine has accepted responsibility for these events" — not "events are in
// RAM and may be dropped on crash."
package storage

import (
	"context"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
)

// EventStore persists captured events for a session.
type EventStore interface {
	// InsertBatch writes events in order. Returns an error if any event failed;
	// implementations should treat the batch atomically where reasonable.
	InsertBatch(ctx context.Context, sessionID string, events []*pb.Event) error

	// Close releases any connections or background workers.
	Close() error
}

// Noop is the zero-cost store used when no persistence backend is configured.
// Useful for Phase 1a-style smoke tests where the SDK + engine loop is the
// only thing under test.
type Noop struct{}

// InsertBatch returns nil.
func (Noop) InsertBatch(_ context.Context, _ string, _ []*pb.Event) error { return nil }

// Close returns nil.
func (Noop) Close() error { return nil }
