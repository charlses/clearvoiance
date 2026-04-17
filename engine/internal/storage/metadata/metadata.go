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
	Get(ctx context.Context, id string) (*SessionRow, error)
	MarkStopped(ctx context.Context, id string, stoppedAt time.Time, events, bytes int64) error
	List(ctx context.Context) ([]SessionRow, error)
	// Heartbeat records that the session is still alive. Used by the auto-close
	// sweeper to distinguish live-but-quiet sessions from abandoned ones.
	Heartbeat(ctx context.Context, id string) error
	// SweepIdle marks sessions stopped when they haven't been heartbeated in
	// `idle`. Returns the ids it closed.
	SweepIdle(ctx context.Context, idle time.Duration) ([]string, error)
}

// ErrReplayNotFound is returned for unknown replay ids.
var ErrReplayNotFound = errors.New("replay not found")

// ReplayRow mirrors the relational state of a replay run.
type ReplayRow struct {
	ID                  string
	SourceSessionID     string
	TargetURL           string
	Speedup             float64
	Label               string
	Status              string // pending | running | completed | failed | cancelled
	StartedAt           time.Time
	FinishedAt          *time.Time
	EventsDispatched    int64
	EventsFailed        int64
	EventsBackpressured int64
	P50LatencyMs        *float64
	P95LatencyMs        *float64
	P99LatencyMs        *float64
	MaxLagMs            *float64
	ErrorMessage        string
}

// ReplayMetrics is the summary written on replay completion.
type ReplayMetrics struct {
	EventsDispatched     int64
	EventsFailed         int64
	EventsBackpressured  int64
	P50LatencyMs         *float64
	P95LatencyMs         *float64
	P99LatencyMs         *float64
	MaxLagMs             *float64
}

// Replays is the subset of metadata ops the replay engine cares about.
type Replays interface {
	Create(ctx context.Context, row ReplayRow) error
	Get(ctx context.Context, id string) (*ReplayRow, error)
	MarkFinished(ctx context.Context, id, status string, finishedAt time.Time,
		metrics ReplayMetrics, errorMessage string) error
}

// APIKeyRow represents a provisioned API key. The plaintext is never stored
// — only the hash (sha256, hex-encoded) is persisted.
type APIKeyRow struct {
	ID         string
	Name       string
	CreatedAt  time.Time
	RevokedAt  *time.Time
	LastUsedAt *time.Time
}

// ErrAPIKeyNotFound is returned for unknown ids / hashes / revoked keys.
var ErrAPIKeyNotFound = errors.New("api key not found")

// APIKeys is the ops surface for machine-to-machine API keys.
type APIKeys interface {
	// Create records a new key. `keyHash` is the operator-supplied hash of
	// the plaintext (so the plaintext never touches this layer).
	Create(ctx context.Context, id, keyHash, name string) error
	// ValidateHash returns (nil, ErrAPIKeyNotFound) if the hash is unknown
	// or revoked; otherwise bumps last_used_at and returns the row.
	ValidateHash(ctx context.Context, keyHash string) (*APIKeyRow, error)
	// Revoke marks the key by id as revoked.
	Revoke(ctx context.Context, id string) error
	// List returns all keys (including revoked), newest first. Plaintext is
	// never returned — callers see only metadata.
	List(ctx context.Context) ([]APIKeyRow, error)
	// Count returns how many API keys have ever been provisioned (revoked
	// included). Used by the auth middleware to decide whether to enforce
	// (count>0) or run in dev-open mode (count=0). Revoking the last key
	// does NOT re-enable dev-open — once you've turned auth on, it stays
	// on even if you rotate to zero active keys.
	Count(ctx context.Context) (int64, error)
}

// Store is the umbrella for every relational surface the engine needs.
type Store interface {
	Sessions() Sessions
	Replays() Replays
	APIKeys() APIKeys
	Close() error
}

// Noop returns an in-memory no-op store. Used when the engine runs without a
// --postgres-dsn; sessions/replays live in process memory only and are lost
// on restart. Fine for dev smoke; production should point at Postgres.
type Noop struct{}

// Sessions returns a noop Sessions implementation.
func (Noop) Sessions() Sessions { return noopSessions{} }

// Replays returns a noop Replays implementation.
func (Noop) Replays() Replays { return noopReplays{} }

// APIKeys returns a noop APIKeys implementation. Count=0 keeps the engine
// in dev-open mode (any non-empty key accepted).
func (Noop) APIKeys() APIKeys { return noopAPIKeys{} }

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
func (noopSessions) Heartbeat(_ context.Context, _ string) error  { return nil }
func (noopSessions) SweepIdle(_ context.Context, _ time.Duration) ([]string, error) {
	return nil, nil
}

type noopReplays struct{}

func (noopReplays) Create(_ context.Context, _ ReplayRow) error { return nil }
func (noopReplays) Get(_ context.Context, _ string) (*ReplayRow, error) {
	return nil, ErrReplayNotFound
}
func (noopReplays) MarkFinished(_ context.Context, _, _ string, _ time.Time,
	_ ReplayMetrics, _ string) error {
	return nil
}

type noopAPIKeys struct{}

func (noopAPIKeys) Create(_ context.Context, _, _, _ string) error  { return nil }
func (noopAPIKeys) ValidateHash(_ context.Context, _ string) (*APIKeyRow, error) {
	return nil, ErrAPIKeyNotFound
}
func (noopAPIKeys) Revoke(_ context.Context, _ string) error     { return nil }
func (noopAPIKeys) List(_ context.Context) ([]APIKeyRow, error)  { return nil, nil }
func (noopAPIKeys) Count(_ context.Context) (int64, error)       { return 0, nil }
