//go:build integration

package sink_test

import (
	"context"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	tcclickhouse "github.com/testcontainers/testcontainers-go/modules/clickhouse"

	"github.com/charlses/clearvoiance/db-observer/internal/observer"
	"github.com/charlses/clearvoiance/db-observer/internal/sink"
)

func TestClickHouseSink_WritesAndReadsBack(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	c, err := tcclickhouse.Run(ctx,
		"clickhouse/clickhouse-server:24-alpine",
		tcclickhouse.WithUsername("default"),
		tcclickhouse.WithPassword("dev"),
		tcclickhouse.WithDatabase("clv_obs"),
		testcontainers.WithHostPortAccess(9000),
	)
	require.NoError(t, err)
	t.Cleanup(func() { _ = c.Terminate(ctx) })

	dsn, err := c.ConnectionString(ctx)
	require.NoError(t, err)

	chSink, err := sink.OpenClickHouse(ctx, dsn)
	require.NoError(t, err)
	t.Cleanup(func() { _ = chSink.Close() })

	obs := []observer.Observation{
		{
			ReplayID:         "rep_1",
			EventID:          "ev_1",
			Type:             observer.ObservationTypeSlowQuery,
			ObservedAt:       time.Now().UTC(),
			DurationNs:       550 * int64(time.Millisecond),
			QueryText:        "SELECT pg_sleep(0.5)",
			QueryFingerprint: "abc123",
		},
		{
			ReplayID:         "rep_1",
			EventID:          "ev_2",
			Type:             observer.ObservationTypeLockWait,
			ObservedAt:       time.Now().UTC(),
			DurationNs:       120 * int64(time.Millisecond),
			QueryText:        "UPDATE leads SET x = 1 WHERE id = $1",
			QueryFingerprint: "def456",
			WaitEventType:    "Lock",
			WaitEvent:        "transactionid",
		},
	}
	for _, o := range obs {
		require.NoError(t, chSink.Emit(ctx, o))
	}
	require.NoError(t, chSink.Flush(ctx))

	// Read back with a fresh CH client.
	opts, err := clickhouse.ParseDSN(dsn)
	require.NoError(t, err)
	reader, err := clickhouse.Open(opts)
	require.NoError(t, err)
	t.Cleanup(func() { _ = reader.Close() })

	var count uint64
	require.NoError(t,
		reader.QueryRow(ctx,
			`SELECT count() FROM db_observations WHERE replay_id = 'rep_1'`).Scan(&count))
	require.Equal(t, uint64(2), count)

	var (
		rows    = 0
		byType  = map[string]int{}
	)
	r, err := reader.Query(ctx,
		`SELECT observation_type, query_fingerprint, wait_event
		   FROM db_observations WHERE replay_id = 'rep_1' ORDER BY event_id`)
	require.NoError(t, err)
	defer r.Close()
	for r.Next() {
		var ty, fp, we string
		require.NoError(t, r.Scan(&ty, &fp, &we))
		byType[ty]++
		rows++
	}
	require.NoError(t, r.Err())
	require.Equal(t, 2, rows)
	require.Equal(t, 1, byType["slow_query"])
	require.Equal(t, 1, byType["lock_wait"])
}
