package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

// newSessionCmd is the `clearvoiance session ...` subcommand tree. All
// subcommands talk to a running engine via gRPC; they don't touch storage
// directly so they work against local and remote engines alike.
func newSessionCmd(_ *slog.Logger) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "session",
		Short: "Manage capture sessions on a running engine.",
	}
	cmd.PersistentFlags().String("engine", "127.0.0.1:9100",
		"Engine gRPC address.")
	cmd.PersistentFlags().String("api-key", "dev",
		"API key. Dev-open mode when no api_keys are provisioned yet.")
	cmd.PersistentFlags().String("postgres-dsn",
		os.Getenv("CLEARVOIANCE_POSTGRES_DSN"),
		"Postgres DSN — used by `list` / `inspect` to read session history directly.")

	cmd.AddCommand(newSessionStartCmd())
	cmd.AddCommand(newSessionStopCmd())
	cmd.AddCommand(newSessionListCmd())
	cmd.AddCommand(newSessionInspectCmd())
	return cmd
}

func newSessionStartCmd() *cobra.Command {
	var (
		name   string
		labels []string
	)
	cmd := &cobra.Command{
		Use:   "start",
		Short: "Open a new capture session and print its id.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if name == "" {
				return errors.New("--name is required")
			}
			engine, _ := cmd.Flags().GetString("engine")
			apiKey, _ := cmd.Flags().GetString("api-key")

			conn, client, err := dialEngine(cmd.Context(), engine)
			if err != nil {
				return err
			}
			defer conn.Close()

			labelMap, err := parseLabels(labels)
			if err != nil {
				return err
			}

			resp, err := client.StartSession(cmd.Context(), &pb.StartSessionRequest{
				Name:   name,
				ApiKey: apiKey,
				Labels: labelMap,
			})
			if err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), resp.GetSessionId())
			return nil
		},
	}
	cmd.Flags().StringVar(&name, "name", "", "Session display name (required).")
	cmd.Flags().StringSliceVar(&labels, "label", nil,
		"key=value labels; repeatable. Example: --label env=staging --label team=platform")
	return cmd
}

func newSessionStopCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "stop <session-id>",
		Short: "Stop an active capture session.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			engine, _ := cmd.Flags().GetString("engine")
			apiKey, _ := cmd.Flags().GetString("api-key")
			conn, client, err := dialEngine(cmd.Context(), engine)
			if err != nil {
				return err
			}
			defer conn.Close()

			resp, err := client.StopSession(cmd.Context(), &pb.StopSessionRequest{
				SessionId: args[0],
				ApiKey:    apiKey,
			})
			if err != nil {
				return err
			}
			out := map[string]any{
				"session_id":      args[0],
				"stopped_at_ns":   resp.GetStoppedAtNs(),
				"events_captured": resp.GetEventsCaptured(),
				"bytes_captured":  resp.GetBytesCaptured(),
			}
			enc := json.NewEncoder(cmd.OutOrStdout())
			enc.SetIndent("", "  ")
			return enc.Encode(out)
		},
	}
	return cmd
}

func newSessionListCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List all sessions recorded in Postgres (newest first).",
		RunE: func(cmd *cobra.Command, _ []string) error {
			dsn, _ := cmd.Flags().GetString("postgres-dsn")
			if dsn == "" {
				return errors.New("--postgres-dsn (or CLEARVOIANCE_POSTGRES_DSN) is required")
			}
			pg, err := metadata.OpenPostgres(cmd.Context(), dsn)
			if err != nil {
				return err
			}
			defer pg.Close()

			rows, err := pg.Sessions().List(cmd.Context())
			if err != nil {
				return err
			}
			enc := json.NewEncoder(cmd.OutOrStdout())
			enc.SetIndent("", "  ")
			return enc.Encode(rows)
		},
	}
	return cmd
}

func newSessionInspectCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "inspect <session-id>",
		Short: "Show a session's metadata + final counters as JSON.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dsn, _ := cmd.Flags().GetString("postgres-dsn")
			if dsn == "" {
				return errors.New("--postgres-dsn (or CLEARVOIANCE_POSTGRES_DSN) is required")
			}
			pg, err := metadata.OpenPostgres(cmd.Context(), dsn)
			if err != nil {
				return err
			}
			defer pg.Close()

			row, err := pg.Sessions().Get(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			enc := json.NewEncoder(cmd.OutOrStdout())
			enc.SetIndent("", "  ")
			return enc.Encode(row)
		},
	}
	return cmd
}

func dialEngine(ctx context.Context, addr string) (*grpc.ClientConn, pb.CaptureServiceClient, error) {
	dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	conn, err := grpc.NewClient(addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("dial %s: %w", addr, err)
	}
	_ = dialCtx // grpc.NewClient is non-blocking; timeout is used per-call.
	return conn, pb.NewCaptureServiceClient(conn), nil
}

func parseLabels(pairs []string) (map[string]string, error) {
	out := make(map[string]string, len(pairs))
	for _, p := range pairs {
		idx := strings.IndexByte(p, '=')
		if idx <= 0 {
			return nil, fmt.Errorf("label %q: expected key=value", p)
		}
		out[p[:idx]] = p[idx+1:]
	}
	return out, nil
}
