package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"

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
		source          string
		target          string
		speedup         float64
		label           string
		virtualUsers    int32
		authMode         string
		authHeader       string
		authPrefix       string
		authToken        string
		authSigningKey   string
		authFreshExpiry  int64
		authCallbackURL  string
		authCacheTTL     int64
		mutatorMode      string
		mutatorPaths     []string
		mutatorIntMul    int64
		mutatorScriptFile string
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

			authMsg, err := buildAuthStrategy(authMode, authHeader, authPrefix,
				authToken, authSigningKey, authFreshExpiry,
				authCallbackURL, authCacheTTL)
			if err != nil {
				return err
			}
			mutatorMsg, err := buildMutatorConfig(mutatorMode, mutatorPaths, mutatorIntMul,
				mutatorScriptFile)
			if err != nil {
				return err
			}

			resp, err := client.StartReplay(cmd.Context(), &pb.StartReplayRequest{
				SourceSessionId: source,
				TargetUrl:       target,
				Speedup:         speedup,
				Label:           label,
				VirtualUsers:    virtualUsers,
				Auth:            authMsg,
				Mutator:         mutatorMsg,
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
	cmd.Flags().Int32Var(&virtualUsers, "virtual-users", 1,
		"Fan each captured event out to N dispatches (with mutator applied per VU). Default 1.")

	cmd.Flags().StringVar(&authMode, "auth", "none",
		"Auth rewrite: none | static-swap | jwt-resign | callback")
	cmd.Flags().StringVar(&authHeader, "auth-header", "",
		"Header to overwrite (default 'Authorization').")
	cmd.Flags().StringVar(&authPrefix, "auth-prefix", "", "Prefix before the token, e.g. 'Bearer '.")
	cmd.Flags().StringVar(&authToken, "auth-token", "", "Token for static-swap auth.")
	cmd.Flags().StringVar(&authSigningKey, "auth-signing-key", "",
		"HMAC secret for jwt-resign auth (HS256).")
	cmd.Flags().Int64Var(&authFreshExpiry, "auth-fresh-expiry", 3600,
		"Expiry (seconds from now) for re-signed JWTs.")
	cmd.Flags().StringVar(&authCallbackURL, "auth-callback-url", "",
		"URL to POST {event_id,user_id,method,path} to; callback returns {header,value}.")
	cmd.Flags().Int64Var(&authCacheTTL, "auth-cache-ttl", 300,
		"Seconds to cache per-user callback responses.")

	cmd.Flags().StringVar(&mutatorMode, "mutator", "none",
		"Body mutator: none | unique-fields | custom-script")
	cmd.Flags().StringSliceVar(&mutatorPaths, "mutator-path", nil,
		"JSONPaths to make unique per VU (e.g. $.email). Repeatable.")
	cmd.Flags().Int64Var(&mutatorIntMul, "mutator-int-multiplier", 1_000_000,
		"Amount added to integer fields per VU: value += vu * multiplier.")
	cmd.Flags().StringVar(&mutatorScriptFile, "mutator-script-file", "",
		"Path to a Starlark mutator script (expects 'def mutate(body, content_type, vu)').")
	return cmd
}

func buildAuthStrategy(mode, header, prefix, token, signingKey string, fresh int64,
	callbackURL string, cacheTTL int64) (*pb.AuthStrategy, error) {
	switch mode {
	case "", "none":
		return &pb.AuthStrategy{Strategy: &pb.AuthStrategy_None{None: &pb.AuthNone{}}}, nil
	case "static-swap":
		if token == "" {
			return nil, errors.New("--auth-token is required for --auth=static-swap")
		}
		return &pb.AuthStrategy{Strategy: &pb.AuthStrategy_StaticSwap{
			StaticSwap: &pb.AuthStaticSwap{Header: header, Prefix: prefix, Token: token},
		}}, nil
	case "jwt-resign":
		if signingKey == "" {
			return nil, errors.New("--auth-signing-key is required for --auth=jwt-resign")
		}
		return &pb.AuthStrategy{Strategy: &pb.AuthStrategy_JwtResign{
			JwtResign: &pb.AuthJwtResign{
				Header: header, Prefix: prefix,
				SigningKey: signingKey, FreshExpirySeconds: fresh,
			},
		}}, nil
	case "callback":
		if callbackURL == "" {
			return nil, errors.New("--auth-callback-url is required for --auth=callback")
		}
		return &pb.AuthStrategy{Strategy: &pb.AuthStrategy_Callback{
			Callback: &pb.AuthCallback{Url: callbackURL, CacheTtlSeconds: cacheTTL},
		}}, nil
	}
	return nil, fmt.Errorf("unknown --auth mode %q (want none | static-swap | jwt-resign | callback)", mode)
}

func buildMutatorConfig(mode string, paths []string, intMul int64, scriptFile string) (*pb.MutatorConfig, error) {
	switch mode {
	case "", "none":
		return &pb.MutatorConfig{Mutator: &pb.MutatorConfig_None{None: &pb.MutatorNone{}}}, nil
	case "unique-fields":
		if len(paths) == 0 {
			return nil, errors.New("--mutator-path is required for --mutator=unique-fields")
		}
		return &pb.MutatorConfig{Mutator: &pb.MutatorConfig_UniqueFields{
			UniqueFields: &pb.MutatorUniqueFields{JsonPaths: paths, IntMultiplier: intMul},
		}}, nil
	case "custom-script":
		if scriptFile == "" {
			return nil, errors.New("--mutator-script-file is required for --mutator=custom-script")
		}
		source, err := os.ReadFile(scriptFile)
		if err != nil {
			return nil, fmt.Errorf("read mutator script: %w", err)
		}
		return &pb.MutatorConfig{Mutator: &pb.MutatorConfig_CustomScript{
			CustomScript: &pb.MutatorCustomScript{Source: string(source)},
		}}, nil
	}
	return nil, fmt.Errorf("unknown --mutator mode %q (want none | unique-fields | custom-script)", mode)
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
