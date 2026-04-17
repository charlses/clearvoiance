// Package metadata is the boundary between the engine and its relational
// metadata store.
//
// Today this is just sessions; future phases (5/6) add API keys, replays,
// and audit log to the same surface. Current implementations: Noop (dev
// default; sessions live in memory only) and Postgres (durable; sessions
// survive engine restart so WAL drain works across a crash).
package metadata

import (
	"context"
	"errors"
	"time"
)

// ErrSessionNotFound is returned by Sessions.Get for unknown ids.
var ErrSessionNotFound = errors.New("session not found")

// SessionRow mirrors what the engine needs to know about a session to route
// captures. Live counters (events, bytes) stay in the in-memory
// sessions.Manager — they're hot-path and we don't persist every increment.
type SessionRow struct {
	ID             string
	Name           string
	Labels         map[string]string
	Status         string // "active" | "stopped"
	StartedAt      time.Time
	StoppedAt      *time.Time
	EventsCaptured int64
	BytesCaptured  int64
}

// Sessions is the subset of metadata ops the session manager cares about.
type Sessions interface {
	Create(ctx context.Context, row SessionRow) error
	// Get returns a session row by id. Returns ErrSessionNotFound if absent.
	Get(ctx context.Context, id string) (*SessionRow, error)
	// MarkStopped records the stop time + final counters.
	MarkStopped(ctx context.Context, id string, stoppedAt time.Time, events, bytes int64) error
	List(ctx context.Context) ([]SessionRow, error)
}

// Store is the umbrella for every relational surface the engine needs.
type Store interface {
	Sessions() Sessions
	Close() error
}

// Noop returns an in-memory no-op store. Used when the engine runs without a
// --postgres-dsn; sessions stay in the session manager's RAM and are lost on
// restart. Fine for dev smoke; production should point at Postgres.
type Noop struct{}

// Sessions returns a noop Sessions implementation.
func (Noop) Sessions() Sessions { return noopSessions{} }

// Close is a no-op.
func (Noop) Close() error { return nil }

type noopSessions struct{}

func (noopSessions) Create(_ context.Context, _ SessionRow) error { return nil }
func (noopSessions) Get(_ context.Context, _ string) (*SessionRow, error) {
	return nil, ErrSessionNotFound
}
func (noopSessions) MarkStopped(_ context.Context, _ string, _ time.Time, _, _ int64) error {
	return nil
}
func (noopSessions) List(_ context.Context) ([]SessionRow, error) { return nil, nil }
