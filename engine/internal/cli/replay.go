package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	"github.com/spf13/cobra"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
)

// newReplayCmd is `clearvoiance replay ...`. Talks to a running engine via gRPC.
func newReplayCmd(_ *slog.Logger) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "replay",
		Short: "Replay a captured session against a target URL.",
	}
	cmd.PersistentFlags().String("engine", "127.0.0.1:9100", "Engine gRPC address.")
	cmd.PersistentFlags().String("api-key", "dev",
		"API key. Phase 1 accepts any non-empty value; real auth lands in Phase 5.")

	cmd.AddCommand(newReplayStartCmd())
	cmd.AddCommand(newReplayStatusCmd())
	return cmd
}

func newReplayStartCmd() *cobra.Command {
	var (
		source  string
		target  string
		speedup float64
		label   string
	)
	cmd := &cobra.Command{
		Use:   "start",
		Short: "Start a replay. Prints the new replay id on stdout.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if source == "" {
				return errors.New("--source is required")
			}
			if target == "" {
				return errors.New("--target is required")
			}
			if speedup <= 0 {
				speedup = 1.0
			}
			engine, _ := cmd.Flags().GetString("engine")

			conn, err := dialReplayEngine(engine)
			if err != nil {
				return err
			}
			defer conn.Close()
			client := pb.NewReplayServiceClient(conn)

			resp, err := client.StartReplay(cmd.Context(), &pb.StartReplayRequest{
				SourceSessionId: source,
				TargetUrl:       target,
				Speedup:         speedup,
				Label:           label,
			})
			if err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), resp.GetReplayId())
			return nil
		},
	}
	cmd.Flags().StringVar(&source, "source", "", "Source session id (required).")
	cmd.Flags().StringVar(&target, "target", "", "Target base URL (e.g. http://staging.local:4000).")
	cmd.Flags().Float64Var(&speedup, "speedup", 1.0, "Dispatch rate multiplier. 12 = 12x faster than captured timing.")
	cmd.Flags().StringVar(&label, "label", "", "Optional human label for the replay.")
	return cmd
}

func newReplayStatusCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "status <replay-id>",
		Short: "Show a replay's current state and metrics as JSON.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			engine, _ := cmd.Flags().GetString("engine")
			conn, err := dialReplayEngine(engine)
			if err != nil {
				return err
			}
			defer conn.Close()
			client := pb.NewReplayServiceClient(conn)

			resp, err := client.GetReplay(cmd.Context(), &pb.GetReplayRequest{
				ReplayId: args[0],
			})
			if err != nil {
				return err
			}
			out := map[string]any{
				"replay_id":         resp.GetReplayId(),
				"source_session_id": resp.GetSourceSessionId(),
				"target_url":        resp.GetTargetUrl(),
				"speedup":           resp.GetSpeedup(),
				"status":            resp.GetStatus(),
				"started_at_ns":     resp.GetStartedAtNs(),
				"finished_at_ns":    resp.GetFinishedAtNs(),
				"events_dispatched": resp.GetEventsDispatched(),
				"events_failed":     resp.GetEventsFailed(),
				"p50_latency_ms":    resp.GetP50LatencyMs(),
				"p95_latency_ms":    resp.GetP95LatencyMs(),
				"p99_latency_ms":    resp.GetP99LatencyMs(),
				"max_lag_ms":        resp.GetMaxLagMs(),
			}
			enc := json.NewEncoder(cmd.OutOrStdout())
			enc.SetIndent("", "  ")
			return enc.Encode(out)
		},
	}
	return cmd
}

func dialReplayEngine(addr string) (*grpc.ClientConn, error) {
	return grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
}
