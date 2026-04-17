package cli

import (
	"context"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"

	capturegrpc "github.com/charlses/clearvoiance/engine/internal/api/grpc"
	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
	"github.com/charlses/clearvoiance/engine/internal/sessions"
	"github.com/charlses/clearvoiance/engine/internal/storage"
	chstore "github.com/charlses/clearvoiance/engine/internal/storage/clickhouse"
)

// Default bind address. Loopback-only by default; operators opt into
// external exposure via `--grpc-addr 0.0.0.0:9100`.
const defaultGRPCAddr = "127.0.0.1:9100"

type serveOpts struct {
	grpcAddr      string
	clickhouseDSN string
}

func newServeCmd(log *slog.Logger, version string) *cobra.Command {
	var opts serveOpts

	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Run the clearvoiance engine (gRPC Capture service).",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runServe(cmd.Context(), log, version, opts)
		},
	}

	cmd.Flags().StringVar(&opts.grpcAddr, "grpc-addr", defaultGRPCAddr,
		"Address the gRPC Capture service listens on.")

	// CLI flag wins; env var is the default for container deployments.
	cmd.Flags().StringVar(&opts.clickhouseDSN, "clickhouse-dsn",
		os.Getenv("CLEARVOIANCE_CLICKHOUSE_DSN"),
		"ClickHouse DSN, e.g. clickhouse://default:dev@localhost:9000/clearvoiance. "+
			"Leave empty to run in ephemeral (noop storage) mode.")

	return cmd
}

func runServe(ctx context.Context, log *slog.Logger, version string, opts serveOpts) error {
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	mgr := sessions.NewManager()

	store, err := openStore(ctx, log, opts.clickhouseDSN)
	if err != nil {
		return err
	}
	defer func() { _ = store.Close() }()

	capture := capturegrpc.NewCaptureServer(log, version, mgr, store)

	lis, err := net.Listen("tcp", opts.grpcAddr)
	if err != nil {
		return err
	}

	srv := grpc.NewServer()
	pb.RegisterCaptureServiceServer(srv, capture)
	// Reflection lets us poke the server with grpcurl during development.
	reflection.Register(srv)

	log.Info("engine listening", "addr", opts.grpcAddr, "version", version)

	serveErr := make(chan error, 1)
	go func() {
		serveErr <- srv.Serve(lis)
	}()

	select {
	case <-ctx.Done():
		log.Info("shutdown signal received, draining")
	case err := <-serveErr:
		return err
	}

	// Graceful stop with a hard ceiling so a wedged client can't keep us hostage.
	done := make(chan struct{})
	go func() {
		srv.GracefulStop()
		close(done)
	}()
	select {
	case <-done:
		log.Info("engine stopped")
	case <-time.After(10 * time.Second):
		log.Warn("graceful stop timed out, forcing")
		srv.Stop()
	}

	return nil
}

// openStore returns a ClickHouse store when a DSN is provided, or a Noop store
// otherwise. Ephemeral mode exists for dev smoke tests; production deployments
// must set a DSN.
func openStore(ctx context.Context, log *slog.Logger, dsn string) (storage.EventStore, error) {
	if dsn == "" {
		log.Warn("no --clickhouse-dsn set — events will be acked but not persisted (ephemeral mode)")
		return storage.Noop{}, nil
	}
	log.Info("connecting to ClickHouse", "dsn_host", redactDSN(dsn))
	return chstore.Open(ctx, dsn)
}

// redactDSN trims credentials from a DSN for safe logging.
func redactDSN(dsn string) string {
	// Good enough: drop everything before the last '@'.
	for i := len(dsn) - 1; i >= 0; i-- {
		if dsn[i] == '@' {
			return "***@" + dsn[i+1:]
		}
	}
	return dsn
}
