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

// Sessions returns the sessions surface.
func (p *Postgres) Sessions() Sessions { return &pgSessions{pool: p.pool} }

// Replays returns the replays surface.
func (p *Postgres) Replays() Replays { return &pgReplays{pool: p.pool} }

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
		&out.EventsDispatched, &out.EventsFailed,
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
		        p50_latency_ms = $6,
		        p95_latency_ms = $7,
		        p99_latency_ms = $8,
		        max_lag_ms = $9,
		        error_message = NULLIF($10, '')
		  WHERE id = $1`,
		id, status, finishedAt,
		m.EventsDispatched, m.EventsFailed,
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
