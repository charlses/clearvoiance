package cli

import (
	"context"
	"log/slog"
	"net"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"

	capturegrpc "github.com/charlses/clearvoiance/engine/internal/api/grpc"
	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
	"github.com/charlses/clearvoiance/engine/internal/sessions"
)

// Default bind address. Loopback-only by default; operators opt into
// external exposure via `--grpc-addr 0.0.0.0:9100`.
const defaultGRPCAddr = "127.0.0.1:9100"

func newServeCmd(log *slog.Logger, version string) *cobra.Command {
	var grpcAddr string

	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Run the clearvoiance engine (gRPC Capture service).",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runServe(cmd.Context(), log, version, grpcAddr)
		},
	}

	cmd.Flags().StringVar(&grpcAddr, "grpc-addr", defaultGRPCAddr,
		"Address the gRPC Capture service listens on.")
	return cmd
}

func runServe(ctx context.Context, log *slog.Logger, version, grpcAddr string) error {
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	mgr := sessions.NewManager()
	capture := capturegrpc.NewCaptureServer(log, version, mgr)

	lis, err := net.Listen("tcp", grpcAddr)
	if err != nil {
		return err
	}

	srv := grpc.NewServer()
	pb.RegisterCaptureServiceServer(srv, capture)
	// Reflection lets us poke the server with grpcurl during development.
	reflection.Register(srv)

	log.Info("engine listening", "addr", grpcAddr, "version", version)

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
