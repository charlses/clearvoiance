package cli

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"

	"github.com/spf13/cobra"

	capturegrpc "github.com/charlses/clearvoiance/engine/internal/api/grpc"
	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

// newAPIKeysCmd is `clearvoiance api-keys ...`. Talks DIRECTLY to Postgres
// (not via gRPC) so operators can rotate credentials even when the engine
// isn't running. Uses the same --postgres-dsn / CLEARVOIANCE_POSTGRES_DSN
// as `serve`.
func newAPIKeysCmd(_ *slog.Logger) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "api-keys",
		Short: "Manage API keys in the engine's Postgres metadata store.",
	}
	cmd.PersistentFlags().String("postgres-dsn",
		os.Getenv("CLEARVOIANCE_POSTGRES_DSN"),
		"Postgres DSN (same as used by `serve`).")

	cmd.AddCommand(newAPIKeysCreateCmd())
	cmd.AddCommand(newAPIKeysListCmd())
	cmd.AddCommand(newAPIKeysRevokeCmd())
	return cmd
}

func newAPIKeysCreateCmd() *cobra.Command {
	var name string
	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new API key. The plaintext is printed ONCE to stdout.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if name == "" {
				return errors.New("--name is required")
			}
			dsn, _ := cmd.Flags().GetString("postgres-dsn")
			if dsn == "" {
				return errors.New("--postgres-dsn (or CLEARVOIANCE_POSTGRES_DSN) is required")
			}
			pg, err := metadata.OpenPostgres(cmd.Context(), dsn)
			if err != nil {
				return err
			}
			defer pg.Close()

			plaintext := generateAPIKey()
			id := newKeyID()
			keyHash := capturegrpc.HashAPIKey(plaintext)

			if err := pg.APIKeys().Create(cmd.Context(), id, keyHash, name); err != nil {
				return fmt.Errorf("create api key: %w", err)
			}
			// Plaintext is shown once, then lost. Operator must copy it now.
			fmt.Fprintf(cmd.OutOrStdout(),
				"%s\n\n→ this is the plaintext; save it now — it is NOT stored server-side.\n   id=%s name=%q\n",
				plaintext, id, name)
			return nil
		},
	}
	cmd.Flags().StringVar(&name, "name", "", "Human label for the key (required).")
	return cmd
}

func newAPIKeysListCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List known API keys (plaintext never shown).",
		RunE: func(cmd *cobra.Command, _ []string) error {
			dsn, _ := cmd.Flags().GetString("postgres-dsn")
			pg, err := metadata.OpenPostgres(cmd.Context(), dsn)
			if err != nil {
				return err
			}
			defer pg.Close()

			rows, err := pg.APIKeys().List(cmd.Context())
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

func newAPIKeysRevokeCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "revoke <id>",
		Short: "Revoke an API key by id. Revoked keys are kept for audit.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dsn, _ := cmd.Flags().GetString("postgres-dsn")
			pg, err := metadata.OpenPostgres(cmd.Context(), dsn)
			if err != nil {
				return err
			}
			defer pg.Close()

			if err := pg.APIKeys().Revoke(cmd.Context(), args[0]); err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), "revoked")
			return nil
		},
	}
	return cmd
}

// generateAPIKey returns a new plaintext key shaped like `clv_live_<32b32>`.
// The `clv_live_` prefix is a convention so operators can spot them on sight
// (similar to Stripe's `sk_live_`). 32 bytes of entropy = 256 bits.
func generateAPIKey() string {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		panic(err)
	}
	enc := base32.StdEncoding.WithPadding(base32.NoPadding)
	return "clv_live_" + enc.EncodeToString(buf[:])
}

// newKeyID returns a short, human-safe id for the api_keys row.
func newKeyID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		panic(err)
	}
	return "key_" + hex.EncodeToString(buf[:])
}

// compile-time guard: sha256 actually imported.
var _ = sha256.Sum256

// helper if future code wants an opaque context: keeps import tidy.
var _ = context.Background
