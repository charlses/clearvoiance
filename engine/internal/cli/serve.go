package cli

import (
	"context"
	"log/slog"
	"net"
	stdhttp "net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"

	"github.com/go-chi/chi/v5"

	capturegrpc "github.com/charlses/clearvoiance/engine/internal/api/grpc"
	enginehttp "github.com/charlses/clearvoiance/engine/internal/api/http"
	"github.com/charlses/clearvoiance/engine/internal/api/rest"
	"github.com/charlses/clearvoiance/engine/internal/api/ws"
	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
	"github.com/charlses/clearvoiance/engine/internal/replay"
	"github.com/charlses/clearvoiance/engine/internal/sessions"
	"github.com/charlses/clearvoiance/engine/internal/storage"
	"github.com/charlses/clearvoiance/engine/internal/storage/blob"
	chstore "github.com/charlses/clearvoiance/engine/internal/storage/clickhouse"
	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

// Default bind addresses. Loopback-only by default; operators opt into
// external exposure via `--grpc-addr 0.0.0.0:9100`.
const (
	defaultGRPCAddr = "127.0.0.1:9100"
	defaultHTTPAddr = "127.0.0.1:9101"
)

type serveOpts struct {
	grpcAddr      string
	httpAddr      string
	clickhouseDSN string
	postgresDSN   string

	// MinIO / S3
	minioEndpoint  string
	minioRegion    string
	minioAccessKey string
	minioSecretKey string
	minioBucket    string
	minioPathStyle bool

	// Dashboard session cookie + CORS. Defaults work for same-origin
	// setups; production deploys on split subdomains set these.
	cookieDomain       string
	cookieSecureAlways bool
	dashboardOrigins   string // comma-separated list
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
	cmd.Flags().StringVar(&opts.httpAddr, "http-addr", defaultHTTPAddr,
		"Address the side-channel HTTP surface (healthz + hermetic unmocked log) listens on.")

	// CLI flag wins; env var is the default for container deployments.
	cmd.Flags().StringVar(&opts.clickhouseDSN, "clickhouse-dsn",
		os.Getenv("CLEARVOIANCE_CLICKHOUSE_DSN"),
		"ClickHouse DSN, e.g. clickhouse://default:dev@localhost:9000/clearvoiance. "+
			"Leave empty to run in ephemeral (noop storage) mode.")

	cmd.Flags().StringVar(&opts.postgresDSN, "postgres-dsn",
		os.Getenv("CLEARVOIANCE_POSTGRES_DSN"),
		"Postgres DSN for metadata (sessions). Leave empty to keep sessions "+
			"in memory only; without this, SDK WALs won't drain across engine restart.")

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

	// Dashboard session cookie + CORS.
	cmd.Flags().StringVar(&opts.cookieDomain, "cookie-domain",
		os.Getenv("CLEARVOIANCE_COOKIE_DOMAIN"),
		"Session cookie Domain attribute. Empty = host-only. Set to a "+
			"parent like '.example.com' when dashboard + engine live on "+
			"different subdomains.")
	cmd.Flags().BoolVar(&opts.cookieSecureAlways, "cookie-secure",
		envOrDefault("CLEARVOIANCE_COOKIE_SECURE", "false") == "true",
		"Force the Secure flag on session cookies even when the "+
			"incoming request looks HTTP. Use behind a TLS terminator "+
			"that strips X-Forwarded-Proto.")
	cmd.Flags().StringVar(&opts.dashboardOrigins, "dashboard-origin",
		os.Getenv("CLEARVOIANCE_DASHBOARD_ORIGIN"),
		"Comma-separated list of origins the dashboard is served from. "+
			"Enables CORS with credentials for those origins. Empty = "+
			"no CORS (same-origin or Bearer-only deploys).")

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

	meta, err := openMetaStore(ctx, log, opts.postgresDSN)
	if err != nil {
		return err
	}
	defer func() { _ = meta.Close() }()

	mgr := sessions.NewManager(meta.Sessions())

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

	capture := capturegrpc.NewCaptureServer(log, version, mgr, store, blobs, meta.APIKeys())

	// Auto-close sessions that haven't heartbeated in 5 minutes. Runs in the
	// background as long as serve() is running; halts on ctx.Done().
	go sweepIdleSessions(ctx, log, mgr)

	// Replay engine: HTTP + Cron + Socket.io dispatchers. BlobRef bodies are
	// rehydrated via the blob store during dispatch.
	replayEngine := replay.NewEngine(
		log, store, store, meta.Replays(), blobs,
		replay.NewHTTPDispatcher(),
		replay.NewCronDispatcher(log),
		replay.NewSocketIODispatcher(log),
		replay.NewQueueDispatcher(log),
	)
	replayGRPC := capturegrpc.NewReplayServer(log, replayEngine, meta.Replays())
	hermeticGRPC := capturegrpc.NewHermeticServer(log, store, meta.APIKeys())

	lis, err := net.Listen("tcp", opts.grpcAddr)
	if err != nil {
		return err
	}

	srv := grpc.NewServer()
	pb.RegisterCaptureServiceServer(srv, capture)
	pb.RegisterReplayServiceServer(srv, replayGRPC)
	pb.RegisterHermeticServiceServer(srv, hermeticGRPC)
	// Reflection lets us poke the server with grpcurl during development.
	reflection.Register(srv)

	log.Info("engine listening", "addr", opts.grpcAddr, "version", version)

	// Unified HTTP surface on opts.httpAddr:
	//   /api/v1/*  — REST control plane
	//   /ws        — live-view WebSocket hub
	//   /docs      — Swagger UI
	//   /hermetic/unmocked — hermetic-mode unmocked outbound log
	//   /healthz   — bare liveness
	wsHub := ws.NewHub(log)
	// Wire progress publishing: every replay run pushes 250ms snapshots
	// onto replay.<id>.progress for any WS subscribers.
	replayEngine.SetProgressPublisher(wsHub)

	metrics := rest.NewMetricsRegistry()
	restDeps := rest.Deps{
		Log:           log,
		Version:       version,
		ClickhouseDSN: opts.clickhouseDSN,
		SessionMgr:    mgr,
		EventStore:    store,
		MetaStore:     meta,
		ReplayEngine:  replayEngine,
		AuditLogger:   auditWriter(meta),
		Metrics:       metrics,
		Config: rest.ConfigView{
			GRPCAddr: opts.grpcAddr,
			HTTPAddr: opts.httpAddr,
			Postgres: opts.postgresDSN,
			MinIO:    opts.minioEndpoint,
		},
		Cookie: rest.CookieConfig{
			Domain:       opts.cookieDomain,
			AlwaysSecure: opts.cookieSecureAlways,
			TTL:          rest.DefaultCookieConfig.TTL,
			SameSite:     rest.DefaultCookieConfig.SameSite,
		},
		CORS: rest.CORSConfig{
			AllowedOrigins:   splitAndTrim(opts.dashboardOrigins),
			AllowCredentials: true,
		},
	}

	// Periodically garbage-collect expired user sessions. One-hour tick
	// is plenty — the auth middleware already rejects expired rows.
	go sweepExpiredUserSessions(ctx, log, meta.UserSessions())

	root := chi.NewRouter()
	root.Mount("/", rest.Router(restDeps))
	root.Handle("/hermetic/unmocked", enginehttp.HermeticUnmockedHandler(log))
	root.Get("/healthz", func(w stdhttp.ResponseWriter, _ *stdhttp.Request) {
		_, _ = w.Write([]byte("ok\n"))
	})
	root.Handle("/ws", ws.Handler(wsHub, meta.APIKeys(), meta.UserSessions()))

	httpSrv := &stdhttp.Server{
		Addr:              opts.httpAddr,
		Handler:           root,
		ReadHeaderTimeout: 5 * time.Second,
	}
	httpErr := make(chan error, 1)
	go func() {
		log.Info("engine http side-channel listening", "addr", opts.httpAddr)
		if err := httpSrv.ListenAndServe(); err != nil && err != stdhttp.ErrServerClosed {
			httpErr <- err
		}
	}()

	serveErr := make(chan error, 1)
	go func() {
		serveErr <- srv.Serve(lis)
	}()

	select {
	case <-ctx.Done():
		log.Info("shutdown signal received, draining")
	case err := <-serveErr:
		_ = httpSrv.Close()
		return err
	case err := <-httpErr:
		srv.GracefulStop()
		return err
	}

	// Graceful stop with a hard ceiling so a wedged client can't keep us hostage.
	done := make(chan struct{})
	go func() {
		srv.GracefulStop()
		close(done)
	}()
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 5*time.Second)
	_ = httpSrv.Shutdown(shutCtx)
	shutCancel()

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

// sweepIdleSessions runs every minute, auto-closing sessions that haven't
// heartbeated in 5 minutes. Stops when ctx is cancelled.
func sweepIdleSessions(ctx context.Context, log *slog.Logger, mgr *sessions.Manager) {
	const idle = 5 * time.Minute
	tick := time.NewTicker(1 * time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			closeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			ids, err := mgr.SweepIdle(closeCtx, idle)
			cancel()
			if err != nil {
				log.Warn("sweep idle sessions", "err", err)
				continue
			}
			if len(ids) > 0 {
				log.Info("auto-closed idle sessions",
					"count", len(ids),
					"idle", idle,
				)
			}
		}
	}
}

// sweepExpiredUserSessions runs hourly, deleting expired rows from
// user_sessions. The Lookup path already rejects expired rows, so this is
// just housekeeping.
func sweepExpiredUserSessions(ctx context.Context, log *slog.Logger, store metadata.UserSessions) {
	tick := time.NewTicker(1 * time.Hour)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			sweepCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			n, err := store.DeleteExpired(sweepCtx)
			cancel()
			if err != nil {
				log.Warn("sweep expired user sessions", "err", err)
				continue
			}
			if n > 0 {
				log.Info("swept expired user sessions", "count", n)
			}
		}
	}
}

// splitAndTrim is a tiny helper for comma-separated flag lists. Empty
// input returns nil (so CORS config treats it as disabled).
func splitAndTrim(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// openMetaStore returns a Postgres-backed metadata store when a DSN is
// provided, or a Noop store otherwise. Noop keeps sessions in-memory and
// breaks WAL drain across engine restart — production must set a DSN.
func openMetaStore(ctx context.Context, log *slog.Logger, dsn string) (metadata.Store, error) {
	if dsn == "" {
		log.Warn("no --postgres-dsn set — sessions will not survive engine restart (SDK WALs won't drain)")
		return metadata.Noop{}, nil
	}
	log.Info("connecting to Postgres (metadata)", "dsn_host", redactDSN(dsn))
	return metadata.OpenPostgres(ctx, dsn)
}

// auditWriter returns a Postgres-backed audit writer when the metadata store
// has a real Postgres pool; returns nil (audit disabled) for Noop deploys.
func auditWriter(meta metadata.Store) rest.AuditWriter {
	pg, ok := meta.(*metadata.Postgres)
	if !ok {
		return nil
	}
	pool := pg.Pool()
	if pool == nil {
		return nil
	}
	return rest.NewPostgresAuditWriter(pool)
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
