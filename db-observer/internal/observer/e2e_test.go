//go:build integration

// End-to-end Phase 4 smoke test: real Postgres → real observer → real
// ClickHouse. Fires a slow query under `clv:ev_e2e_1` application_name and
// asserts a row lands in db_observations with the correct event_id +
// observation type. This is the ground truth that the whole correlation
// chain works.

package observer_test

import (
	"context"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	tcclickhouse "github.com/testcontainers/testcontainers-go/modules/clickhouse"

	"github.com/charlses/clearvoiance/db-observer/internal/observer"
	"github.com/charlses/clearvoiance/db-observer/internal/sink"
)

func TestE2E_PgToObserverToClickhouseToQuery(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()

	// --- Spin up Postgres and ClickHouse side by side. ---
	pgDSN := startPostgres(ctx, t)

	ch, err := tcclickhouse.Run(ctx,
		"clickhouse/clickhouse-server:24-alpine",
		tcclickhouse.WithUsername("default"),
		tcclickhouse.WithPassword("dev"),
		tcclickhouse.WithDatabase("clv_test"),
		testcontainers.WithHostPortAccess(9000),
	)
	require.NoError(t, err)
	t.Cleanup(func() { _ = ch.Terminate(ctx) })
	chDSN, err := ch.ConnectionString(ctx)
	require.NoError(t, err)

	// --- Wire observer → CH sink. ---
	chSink, err := sink.OpenClickHouse(ctx, chDSN)
	require.NoError(t, err)
	t.Cleanup(func() { _ = chSink.Close() })

	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	obs, err := observer.New(ctx, log, observer.Config{
		PostgresDSN:          pgDSN,
		PollInterval:         100 * time.Millisecond,
		SlowQueryThresholdMs: 200,
	}, chSink)
	require.NoError(t, err)
	t.Cleanup(func() { _ = obs.Close() })

	pollCtx, pollCancel := context.WithCancel(ctx)
	defer pollCancel()
	go func() { _ = obs.Run(pollCtx) }()

	// --- SUT pool tagged with a replay-style app name. ---
	cfg, err := pgxpool.ParseConfig(pgDSN)
	require.NoError(t, err)
	cfg.ConnConfig.RuntimeParams["application_name"] = "clv:rep_e2e:ev_e2e_1"

	sut, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(sut.Close)

	// Fire a slow query.
	_, err = sut.Exec(ctx, `SELECT pg_sleep(0.6)`)
	require.NoError(t, err)

	// Give the observer a tick to process + the sink to flush.
	time.Sleep(400 * time.Millisecond)
	require.NoError(t, chSink.Flush(ctx))

	// --- Read back from ClickHouse using a fresh client. ---
	chOpts, err := clickhouse.ParseDSN(chDSN)
	require.NoError(t, err)
	reader, err := clickhouse.Open(chOpts)
	require.NoError(t, err)
	t.Cleanup(func() { _ = reader.Close() })

	var rowCount uint64
	require.NoError(t,
		reader.QueryRow(ctx,
			`SELECT count() FROM db_observations WHERE event_id = 'ev_e2e_1'`).Scan(&rowCount),
	)
	require.GreaterOrEqual(t, rowCount, uint64(1),
		"expected at least one observation for ev_e2e_1")

	var (
		replayID string
		obsType  string
		durMs    float64
	)
	require.NoError(t,
		reader.QueryRow(ctx,
			`SELECT replay_id, observation_type, duration_ns / 1000000.0
			   FROM db_observations WHERE event_id = 'ev_e2e_1' LIMIT 1`).
			Scan(&replayID, &obsType, &durMs))

	require.Equal(t, "rep_e2e", replayID)
	require.Equal(t, "slow_query", obsType)
	require.GreaterOrEqual(t, durMs, 200.0,
		"duration should be at least the threshold, got %.1fms", durMs)
}
