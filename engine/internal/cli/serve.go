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
	"github.com/charlses/clearvoiance/engine/internal/storage/blob"
	chstore "github.com/charlses/clearvoiance/engine/internal/storage/clickhouse"
)

// Default bind address. Loopback-only by default; operators opt into
// external exposure via `--grpc-addr 0.0.0.0:9100`.
const defaultGRPCAddr = "127.0.0.1:9100"

type serveOpts struct {
	grpcAddr      string
	clickhouseDSN string

	// MinIO / S3
	minioEndpoint  string
	minioRegion    string
	minioAccessKey string
	minioSecretKey string
	minioBucket    string
	minioPathStyle bool
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

	// Blob storage (S3-compatible). All empty → no blob backend, SDKs fall
	// back to inline-or-truncate for large bodies.
	cmd.Flags().StringVar(&opts.minioEndpoint, "minio-endpoint",
		os.Getenv("CLEARVOIANCE_MINIO_ENDPOINT"),
		"S3-compatible endpoint URL (e.g. http://minio:9000). Empty = disable blob storage.")
	cmd.Flags().StringVar(&opts.minioRegion, "minio-region",
		envOrDefault("CLEARVOIANCE_MINIO_REGION", "us-east-1"),
		"S3 region.")
	cmd.Flags().StringVar(&opts.minioAccessKey, "minio-access-key",
		os.Getenv("CLEARVOIANCE_MINIO_ACCESS_KEY"), "S3 access key.")
	cmd.Flags().StringVar(&opts.minioSecretKey, "minio-secret-key",
		os.Getenv("CLEARVOIANCE_MINIO_SECRET_KEY"), "S3 secret key.")
	cmd.Flags().StringVar(&opts.minioBucket, "minio-bucket",
		envOrDefault("CLEARVOIANCE_MINIO_BUCKET", "clearvoiance-blobs"),
		"Bucket blobs land in. Must already exist.")
	cmd.Flags().BoolVar(&opts.minioPathStyle, "minio-path-style",
		envOrDefault("CLEARVOIANCE_MINIO_PATH_STYLE", "true") == "true",
		"Use path-style addressing (required for MinIO).")

	return cmd
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
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

	blobs, err := openBlobStore(log, opts)
	if err != nil {
		return err
	}
	defer func() { _ = blobs.Close() }()

	capture := capturegrpc.NewCaptureServer(log, version, mgr, store, blobs)

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

// openBlobStore returns an S3-backed blob store when --minio-endpoint is set,
// or a Noop store otherwise. With Noop, SDKs fall back to inline/truncate.
func openBlobStore(log *slog.Logger, opts serveOpts) (blob.Store, error) {
	if opts.minioEndpoint == "" {
		log.Warn("no --minio-endpoint set — large bodies will be inlined up to the cap or truncated")
		return blob.Noop{}, nil
	}
	log.Info("blob storage enabled", "endpoint", opts.minioEndpoint, "bucket", opts.minioBucket)
	return blob.OpenS3(blob.S3Config{
		Endpoint:     opts.minioEndpoint,
		Region:       opts.minioRegion,
		AccessKey:    opts.minioAccessKey,
		SecretKey:    opts.minioSecretKey,
		Bucket:       opts.minioBucket,
		UsePathStyle: opts.minioPathStyle,
	})
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
