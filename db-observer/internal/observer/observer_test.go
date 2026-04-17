//go:build integration

// Run with: `go test -tags=integration ./db-observer/...`
//
// Real Postgres via testcontainers-go. Verifies the full observer loop:
// set application_name on a client, fire a slow query, assert the observer
// emits one SlowQuery observation correlated to the exact event id.

package observer_test

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/charlses/clearvoiance/db-observer/internal/observer"
	"github.com/charlses/clearvoiance/db-observer/internal/sink"
)

func startPostgres(ctx context.Context, t *testing.T) string {
	t.Helper()
	c, err := tcpostgres.Run(ctx,
		"postgres:16-alpine",
		tcpostgres.WithDatabase("test"),
		tcpostgres.WithUsername("test"),
		tcpostgres.WithPassword("test"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(60*time.Second),
		),
	)
	require.NoError(t, err)
	t.Cleanup(func() {
		if err := c.Terminate(ctx); err != nil {
			t.Logf("terminate postgres: %v", err)
		}
	})
	dsn, err := c.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)
	return dsn
}

func TestObserver_EmitsSlowQueryForClvApp(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	dsn := startPostgres(ctx, t)

	mem := sink.NewMemory()
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	obs, err := observer.New(ctx, log, observer.Config{
		PostgresDSN:          dsn,
		PollInterval:         100 * time.Millisecond,
		SlowQueryThresholdMs: 200, // must be less than our sleep
	}, mem)
	require.NoError(t, err)
	t.Cleanup(func() { _ = obs.Close() })

	// Separate "SUT" pool. Set application_name at connect-time; pgx supports
	// this via RuntimeParams so we don't race the first query.
	cfg, err := pgxpool.ParseConfig(dsn)
	require.NoError(t, err)
	cfg.ConnConfig.RuntimeParams["application_name"] = "clv:ev_obs_test_1"

	sut, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(sut.Close)

	// Kick off the observer poll loop.
	pollCtx, pollCancel := context.WithCancel(ctx)
	defer pollCancel()
	go func() {
		if err := obs.Run(pollCtx); err != nil && err != context.Canceled {
			t.Logf("observer run: %v", err)
		}
	}()

	// Fire a known-slow query (500ms) on the SUT pool. The observer must
	// sample it mid-flight.
	queryErr := make(chan error, 1)
	go func() {
		_, err := sut.Exec(ctx, `SELECT pg_sleep(0.5)`)
		queryErr <- err
	}()

	require.NoError(t, <-queryErr, "SUT query should succeed")

	// Give one more poll tick to process.
	time.Sleep(200 * time.Millisecond)

	// Now snapshot observations. Must have at least one SlowQuery for our event.
	rows := mem.Observations()
	var matched []observer.Observation
	for _, r := range rows {
		if r.EventID == "ev_obs_test_1" && r.Type == observer.ObservationTypeSlowQuery {
			matched = append(matched, r)
		}
	}
	require.NotEmpty(t, matched,
		"expected at least one slow_query observation for ev_obs_test_1, got:\n%s",
		formatObs(rows))

	o := matched[0]
	require.Equal(t, "ev_obs_test_1", o.EventID)
	require.GreaterOrEqual(t, o.DurationNs, int64(200*time.Millisecond))
	require.NotEmpty(t, o.QueryFingerprint)
	require.Contains(t, o.QueryText, "pg_sleep")
}

func TestObserver_IgnoresNonClvApps(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	dsn := startPostgres(ctx, t)

	mem := sink.NewMemory()
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	obs, err := observer.New(ctx, log, observer.Config{
		PostgresDSN:          dsn,
		PollInterval:         100 * time.Millisecond,
		SlowQueryThresholdMs: 100,
	}, mem)
	require.NoError(t, err)
	t.Cleanup(func() { _ = obs.Close() })

	cfg, err := pgxpool.ParseConfig(dsn)
	require.NoError(t, err)
	cfg.ConnConfig.RuntimeParams["application_name"] = "some-other-app"

	sut, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(sut.Close)

	pollCtx, pollCancel := context.WithCancel(ctx)
	defer pollCancel()
	go func() { _ = obs.Run(pollCtx) }()

	_, err = sut.Exec(ctx, `SELECT pg_sleep(0.4)`)
	require.NoError(t, err)
	time.Sleep(200 * time.Millisecond)

	// No observations expected — app_name wasn't clv:.
	require.Empty(t, mem.Observations())
}

func TestObserver_Debounce_OneEmissionPerSlowQuery(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	dsn := startPostgres(ctx, t)

	mem := sink.NewMemory()
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	obs, err := observer.New(ctx, log, observer.Config{
		PostgresDSN:          dsn,
		PollInterval:         100 * time.Millisecond,
		SlowQueryThresholdMs: 150,
	}, mem)
	require.NoError(t, err)
	t.Cleanup(func() { _ = obs.Close() })

	cfg, err := pgxpool.ParseConfig(dsn)
	require.NoError(t, err)
	cfg.ConnConfig.RuntimeParams["application_name"] = "clv:ev_debounce"

	sut, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(sut.Close)

	pollCtx, pollCancel := context.WithCancel(ctx)
	defer pollCancel()
	go func() { _ = obs.Run(pollCtx) }()

	// One long query that crosses the threshold and sticks around for ~8 polls.
	_, err = sut.Exec(ctx, `SELECT pg_sleep(0.8)`)
	require.NoError(t, err)
	time.Sleep(200 * time.Millisecond)

	var slowObs []observer.Observation
	for _, o := range mem.Observations() {
		if o.EventID == "ev_debounce" && o.Type == observer.ObservationTypeSlowQuery {
			slowObs = append(slowObs, o)
		}
	}
	require.Len(t, slowObs, 1,
		"debounce should emit exactly 1 observation per in-flight slow query, got %d",
		len(slowObs))
}

func formatObs(obs []observer.Observation) string {
	s := ""
	for _, o := range obs {
		s += fmt.Sprintf("  event=%q type=%s duration=%dms query=%q\n",
			o.EventID, o.Type, o.DurationNs/int64(time.Millisecond), o.QueryText)
	}
	if s == "" {
		s = "  (none)"
	}
	return s
}
