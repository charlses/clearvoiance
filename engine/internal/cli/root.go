// Package cli wires Cobra subcommands for the clearvoiance engine CLI.
package cli

import (
	"github.com/spf13/cobra"

	"github.com/charlses/clearvoiance/engine/internal/telemetry"
)

// Execute builds the root command tree and runs it against os.Args.
// version is stamped into `clearvoiance version` output and response handshakes.
func Execute(version string) error {
	log := telemetry.NewLogger()

	root := &cobra.Command{
		Use:           "clearvoiance",
		Short:         "Capture real traffic and replay it at N\u00d7 speed against your system.",
		SilenceUsage:  true,
		SilenceErrors: true,
	}

	root.AddCommand(newVersionCmd(version))
	root.AddCommand(newServeCmd(log, version))
	root.AddCommand(newSessionCmd(log))
	root.AddCommand(newReplayCmd(log))
	root.AddCommand(newAPIKeysCmd(log))

	if err := root.Execute(); err != nil {
		log.Error("command failed", "err", err)
		return err
	}
	return nil
}
