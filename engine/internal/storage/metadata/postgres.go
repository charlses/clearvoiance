// Postgres-backed metadata store. Used when the engine runs with
// --postgres-dsn. Persists sessions so a SDK-side WAL survives engine restarts.

package metadata

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed postgres_schema.sql
var pgSchemaSQL string

// Postgres is a Store backed by a Postgres-compatible database.
type Postgres struct {
	pool *pgxpool.Pool
}

// OpenPostgres connects and applies migrations idempotently.
func OpenPostgres(ctx context.Context, dsn string) (*Postgres, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("postgres pool: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("postgres ping: %w", err)
	}

	for _, stmt := range splitStatements(pgSchemaSQL) {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			pool.Close()
			return nil, fmt.Errorf("postgres migrate: %w", err)
		}
	}

	return &Postgres{pool: pool}, nil
}

// Pool exposes the underlying pgxpool for callers that need direct access
// (e.g. the audit-log writer in api/rest). Returns nil only when Open hasn't
// run yet. Prefer the typed surfaces (Sessions/Replays/APIKeys) when
// possible — this exists so new tables don't need their own constructor
// boilerplate every time.
func (p *Postgres) Pool() *pgxpool.Pool { return p.pool }

// Sessions returns the sessions surface.
func (p *Postgres) Sessions() Sessions { return &pgSessions{pool: p.pool} }

// Replays returns the replays surface.
func (p *Postgres) Replays() Replays { return &pgReplays{pool: p.pool} }

// APIKeys returns the api-keys surface.
func (p *Postgres) APIKeys() APIKeys { return &pgAPIKeys{pool: p.pool} }

// Close drains the connection pool.
func (p *Postgres) Close() error {
	if p.pool != nil {
		p.pool.Close()
	}
	return nil
}

type pgSessions struct {
	pool *pgxpool.Pool
}

func (s *pgSessions) Create(ctx context.Context, row SessionRow) error {
	labels, err := json.Marshal(row.Labels)
	if err != nil {
		return fmt.Errorf("marshal labels: %w", err)
	}
	_, err = s.pool.Exec(ctx,
		`INSERT INTO sessions (id, name, labels, status, started_at)
		 VALUES ($1, $2, $3, $4, $5)`,
		row.ID, row.Name, labels, row.Status, row.StartedAt,
	)
	return err
}

func (s *pgSessions) Get(ctx context.Context, id string) (*SessionRow, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT id, name, labels, status, started_at, stopped_at,
		        events_captured, bytes_captured
		   FROM sessions WHERE id = $1`,
		id,
	)
	var r SessionRow
	var labelsJSON []byte
	var stoppedAt *time.Time
	err := row.Scan(&r.ID, &r.Name, &labelsJSON, &r.Status, &r.StartedAt,
		&stoppedAt, &r.EventsCaptured, &r.BytesCaptured)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrSessionNotFound
		}
		return nil, err
	}
	r.StoppedAt = stoppedAt
	if len(labelsJSON) > 0 {
		if err := json.Unmarshal(labelsJSON, &r.Labels); err != nil {
			return nil, fmt.Errorf("unmarshal labels: %w", err)
		}
	}
	return &r, nil
}

func (s *pgSessions) MarkStopped(ctx context.Context, id string, stoppedAt time.Time, events, bytes int64) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE sessions
		    SET status = 'stopped',
		        stopped_at = $2,
		        events_captured = $3,
		        bytes_captured = $4
		  WHERE id = $1`,
		id, stoppedAt, events, bytes,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrSessionNotFound
	}
	return nil
}

func (s *pgSessions) Heartbeat(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE sessions SET last_heartbeat_at = NOW()
		  WHERE id = $1 AND status = 'active'`,
		id,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrSessionNotFound
	}
	return nil
}

func (s *pgSessions) SweepIdle(ctx context.Context, idle time.Duration) ([]string, error) {
	rows, err := s.pool.Query(ctx,
		`UPDATE sessions
		    SET status = 'stopped',
		        stopped_at = NOW()
		  WHERE status = 'active'
		    AND last_heartbeat_at < NOW() - make_interval(secs => $1)
		 RETURNING id`,
		idle.Seconds(),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *pgSessions) List(ctx context.Context) ([]SessionRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, name, labels, status, started_at, stopped_at,
		        events_captured, bytes_captured
		   FROM sessions ORDER BY started_at DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []SessionRow{}
	for rows.Next() {
		var r SessionRow
		var labelsJSON []byte
		var stoppedAt *time.Time
		if err := rows.Scan(&r.ID, &r.Name, &labelsJSON, &r.Status, &r.StartedAt,
			&stoppedAt, &r.EventsCaptured, &r.BytesCaptured); err != nil {
			return nil, err
		}
		r.StoppedAt = stoppedAt
		if len(labelsJSON) > 0 {
			if err := json.Unmarshal(labelsJSON, &r.Labels); err != nil {
				return nil, err
			}
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// splitStatements drops -- comment lines and splits on semicolons. Same
// pattern as the ClickHouse migration runner; see storage/clickhouse.
func splitStatements(script string) []string {
	var buf strings.Builder
	for _, line := range strings.Split(script, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		buf.WriteString(line)
		buf.WriteByte('\n')
	}
	raw := strings.Split(buf.String(), ";")
	out := make([]string, 0, len(raw))
	for _, s := range raw {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// --- replays ---

type pgReplays struct {
	pool *pgxpool.Pool
}

func (r *pgReplays) Create(ctx context.Context, row ReplayRow) error {
	_, err := r.pool.Exec(ctx,
		`INSERT INTO replays
		   (id, source_session_id, target_url, speedup, label, status, started_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		row.ID, row.SourceSessionID, row.TargetURL, row.Speedup,
		row.Label, row.Status, row.StartedAt,
	)
	return err
}

func (r *pgReplays) Get(ctx context.Context, id string) (*ReplayRow, error) {
	row := r.pool.QueryRow(ctx,
		`SELECT id, source_session_id, target_url, speedup, label, status,
		        started_at, finished_at, events_dispatched, events_failed,
		        events_backpressured,
		        p50_latency_ms, p95_latency_ms, p99_latency_ms, max_lag_ms,
		        COALESCE(error_message, '')
		   FROM replays WHERE id = $1`,
		id,
	)
	var out ReplayRow
	var finishedAt *time.Time
	var p50, p95, p99, maxLag *float64
	err := row.Scan(&out.ID, &out.SourceSessionID, &out.TargetURL, &out.Speedup,
		&out.Label, &out.Status, &out.StartedAt, &finishedAt,
		&out.EventsDispatched, &out.EventsFailed, &out.EventsBackpressured,
		&p50, &p95, &p99, &maxLag, &out.ErrorMessage)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrReplayNotFound
		}
		return nil, err
	}
	out.FinishedAt = finishedAt
	out.P50LatencyMs = p50
	out.P95LatencyMs = p95
	out.P99LatencyMs = p99
	out.MaxLagMs = maxLag
	return &out, nil
}

func (r *pgReplays) MarkFinished(ctx context.Context, id, status string,
	finishedAt time.Time, m ReplayMetrics, errorMessage string) error {
	tag, err := r.pool.Exec(ctx,
		`UPDATE replays
		    SET status = $2,
		        finished_at = $3,
		        events_dispatched = $4,
		        events_failed = $5,
		        events_backpressured = $6,
		        p50_latency_ms = $7,
		        p95_latency_ms = $8,
		        p99_latency_ms = $9,
		        max_lag_ms = $10,
		        error_message = NULLIF($11, '')
		  WHERE id = $1`,
		id, status, finishedAt,
		m.EventsDispatched, m.EventsFailed, m.EventsBackpressured,
		m.P50LatencyMs, m.P95LatencyMs, m.P99LatencyMs, m.MaxLagMs,
		errorMessage,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrReplayNotFound
	}
	return nil
}

// --- api_keys ---

type pgAPIKeys struct {
	pool *pgxpool.Pool
}

func (a *pgAPIKeys) Create(ctx context.Context, id, keyHash, name string) error {
	_, err := a.pool.Exec(ctx,
		`INSERT INTO api_keys (id, key_hash, name) VALUES ($1, $2, $3)`,
		id, keyHash, name,
	)
	return err
}

func (a *pgAPIKeys) ValidateHash(ctx context.Context, keyHash string) (*APIKeyRow, error) {
	row := a.pool.QueryRow(ctx,
		`UPDATE api_keys SET last_used_at = NOW()
		  WHERE key_hash = $1 AND revoked_at IS NULL
		 RETURNING id, name, created_at, revoked_at, last_used_at`,
		keyHash,
	)
	var r APIKeyRow
	var revokedAt, lastUsedAt *time.Time
	err := row.Scan(&r.ID, &r.Name, &r.CreatedAt, &revokedAt, &lastUsedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrAPIKeyNotFound
		}
		return nil, err
	}
	r.RevokedAt = revokedAt
	r.LastUsedAt = lastUsedAt
	return &r, nil
}

func (a *pgAPIKeys) Revoke(ctx context.Context, id string) error {
	tag, err := a.pool.Exec(ctx,
		`UPDATE api_keys SET revoked_at = NOW()
		  WHERE id = $1 AND revoked_at IS NULL`,
		id,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrAPIKeyNotFound
	}
	return nil
}

func (a *pgAPIKeys) List(ctx context.Context) ([]APIKeyRow, error) {
	rows, err := a.pool.Query(ctx,
		`SELECT id, name, created_at, revoked_at, last_used_at
		   FROM api_keys ORDER BY created_at DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []APIKeyRow{}
	for rows.Next() {
		var r APIKeyRow
		var revokedAt, lastUsedAt *time.Time
		if err := rows.Scan(&r.ID, &r.Name, &r.CreatedAt, &revokedAt, &lastUsedAt); err != nil {
			return nil, err
		}
		r.RevokedAt = revokedAt
		r.LastUsedAt = lastUsedAt
		out = append(out, r)
	}
	return out, rows.Err()
}

// Count returns the number of API keys ever provisioned (revoked + active).
// The auth middleware uses this to decide whether to enforce the key
// denylist — once ANY key has ever existed, dev-open mode is permanently
// off. Counting active-only would mean revoking the last key silently
// re-opens the engine to any Bearer, which is a nasty foot-gun.
func (a *pgAPIKeys) Count(ctx context.Context) (int64, error) {
	var n int64
	err := a.pool.QueryRow(ctx,
		`SELECT count(*) FROM api_keys`,
	).Scan(&n)
	return n, err
}
