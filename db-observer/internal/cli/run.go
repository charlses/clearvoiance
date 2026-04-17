// Package cli wires the observer's `run` subcommand.
package cli

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/charlses/clearvoiance/db-observer/internal/observer"
	"github.com/charlses/clearvoiance/db-observer/internal/sink"
)

// NewRootCmd builds the observer's top-level CLI.
func NewRootCmd(version string) *cobra.Command {
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

	root := &cobra.Command{
		Use:   "clearvoiance-observer",
		Short: "Correlate SUT DB performance problems to replay events.",
		Long: "The db-observer polls pg_stat_activity for queries carrying a " +
			"clv:<event_id> application_name (set by the SDK's instrumentPg) " +
			"and emits DbObservation records so operators can attribute slow " +
			"queries and lock waits to the replay events that caused them.",
		Version: version,
	}

	root.AddCommand(newRunCmd(log))
	return root
}

type runOpts struct {
	postgresDSN        string
	clickhouseDSN      string
	pollInterval       time.Duration
	slowThresholdMs    int64
	printObservations  bool
}

func newRunCmd(log *slog.Logger) *cobra.Command {
	var opts runOpts

	cmd := &cobra.Command{
		Use:   "run",
		Short: "Run the observer against a SUT Postgres, emitting to ClickHouse.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runObserver(cmd.Context(), log, opts)
		},
	}

	cmd.Flags().StringVar(&opts.postgresDSN, "postgres-dsn",
		envOr("CLEARVOIANCE_OBSERVER_POSTGRES_DSN", ""),
		"Postgres DSN of the SUT database (read-only user recommended).")
	cmd.Flags().StringVar(&opts.clickhouseDSN, "clickhouse-dsn",
		envOr("CLEARVOIANCE_OBSERVER_CLICKHOUSE_DSN", ""),
		"ClickHouse DSN for the db_observations table. Leave empty + use --print for dev.")
	cmd.Flags().DurationVar(&opts.pollInterval, "poll-interval",
		observer.DefaultPollInterval,
		"How often to snapshot pg_stat_activity.")
	cmd.Flags().Int64Var(&opts.slowThresholdMs, "slow-threshold-ms",
		observer.DefaultSlowQueryThresholdMs,
		"Queries slower than this threshold emit a slow_query observation.")
	cmd.Flags().BoolVar(&opts.printObservations, "print", false,
		"Print observations to stdout instead of persisting to ClickHouse. Dev-mode only.")

	return cmd
}

func runObserver(ctx context.Context, log *slog.Logger, opts runOpts) error {
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if opts.postgresDSN == "" {
		return cliErr("--postgres-dsn (or CLEARVOIANCE_OBSERVER_POSTGRES_DSN) is required")
	}

	var s observer.Sink
	switch {
	case opts.printObservations:
		log.Info("observer sink: stdout (--print)")
		s = sink.NewStdout()
	case opts.clickhouseDSN != "":
		log.Info("observer sink: clickhouse")
		ch, err := sink.OpenClickHouse(ctx, opts.clickhouseDSN)
		if err != nil {
			return err
		}
		s = ch
	default:
		return cliErr("must pass --clickhouse-dsn or --print")
	}

	obs, err := observer.New(ctx, log, observer.Config{
		PostgresDSN:          opts.postgresDSN,
		PollInterval:         opts.pollInterval,
		SlowQueryThresholdMs: opts.slowThresholdMs,
	}, s)
	if err != nil {
		return err
	}
	defer func() { _ = obs.Close() }()

	return obs.Run(ctx)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

type cliError string

func (e cliError) Error() string { return string(e) }
func cliErr(s string) error      { return cliError(s) }
