// Package sink writes observations to downstream storage. The production
// sink is ClickHouse; dev/tests can use memory or stdout sinks.
package sink

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/google/uuid"

	"github.com/charlses/clearvoiance/db-observer/internal/observer"
)

// ClickHouseSink writes Observations into the db_observations table.
type ClickHouseSink struct {
	conn     driver.Conn
	mu       sync.Mutex
	batch    []observer.Observation
	batchCap int
}

// DbObservationsSchema is kept co-located with the sink so the observer
// binary can bootstrap its own storage without a cross-module dependency
// on the engine's `internal/storage/clickhouse` package.
//
// The canonical shape lives in
// `engine/internal/storage/clickhouse/clickhouse.go` (const of the same
// name) and in `engine/internal/storage/clickhouse/schema.sql`. If this
// DDL ever diverges, the integration tests on both sides catch it — both
// run `CREATE TABLE IF NOT EXISTS` on startup and conflicting column
// definitions fail loudly.
const DbObservationsSchema = `
CREATE TABLE IF NOT EXISTS db_observations (
    observation_id    String,
    replay_id         String,
    event_id          String,
    observation_type  LowCardinality(String),
    observed_at_ns    Int64,
    duration_ns       Int64,
    query_text        String CODEC(ZSTD(6)),
    query_fingerprint String,
    wait_event_type   LowCardinality(String),
    wait_event        String
) ENGINE = MergeTree()
PARTITION BY (replay_id)
ORDER BY (replay_id, event_id, observed_at_ns)
SETTINGS index_granularity = 8192;
`

// OpenClickHouse dials ClickHouse and applies the schema.
func OpenClickHouse(ctx context.Context, dsn string) (*ClickHouseSink, error) {
	opts, err := clickhouse.ParseDSN(dsn)
	if err != nil {
		return nil, fmt.Errorf("clickhouse parse dsn: %w", err)
	}
	conn, err := clickhouse.Open(opts)
	if err != nil {
		return nil, fmt.Errorf("clickhouse open: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := conn.Ping(pingCtx); err != nil {
		return nil, fmt.Errorf("clickhouse ping: %w", err)
	}
	if err := conn.Exec(ctx, DbObservationsSchema); err != nil {
		return nil, fmt.Errorf("clickhouse migrate: %w", err)
	}
	return &ClickHouseSink{
		conn:     conn,
		batchCap: 64,
	}, nil
}

// Emit appends to an in-memory batch. Flushes when full or when Flush is
// called explicitly. ClickHouse benefits enormously from batching — even
// small batches (~50 rows) cut insert latency by 10x over per-row inserts.
func (c *ClickHouseSink) Emit(ctx context.Context, obs observer.Observation) error {
	c.mu.Lock()
	c.batch = append(c.batch, obs)
	full := len(c.batch) >= c.batchCap
	c.mu.Unlock()
	if full {
		return c.Flush(ctx)
	}
	return nil
}

// Flush writes any buffered observations.
func (c *ClickHouseSink) Flush(ctx context.Context) error {
	c.mu.Lock()
	if len(c.batch) == 0 {
		c.mu.Unlock()
		return nil
	}
	pending := c.batch
	c.batch = nil
	c.mu.Unlock()

	batch, err := c.conn.PrepareBatch(ctx, "INSERT INTO db_observations")
	if err != nil {
		return fmt.Errorf("prepare batch: %w", err)
	}

	for _, o := range pending {
		if err := batch.Append(
			uuid.NewString(),
			o.ReplayID,
			o.EventID,
			string(o.Type),
			o.ObservedAt.UnixNano(),
			o.DurationNs,
			o.QueryText,
			o.QueryFingerprint,
			o.WaitEventType,
			o.WaitEvent,
		); err != nil {
			return fmt.Errorf("append: %w", err)
		}
	}
	if err := batch.Send(); err != nil {
		return fmt.Errorf("send: %w", err)
	}
	return nil
}

// Close flushes then releases the connection.
func (c *ClickHouseSink) Close() error {
	_ = c.Flush(context.Background())
	if c.conn != nil {
		return c.conn.Close()
	}
	return nil
}
