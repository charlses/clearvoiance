// Command clearvoiance is the CLI and engine entry point.
//
// Phase 0: prints version and exits. Real subcommands land in Phase 1.
package main

import (
	"fmt"
	"os"

	"github.com/charlses/clearvoiance/engine/internal/telemetry"
)

// version is set at build time via -ldflags "-X main.version=..."
var version = "0.0.0-dev"

func main() {
	log := telemetry.NewLogger()

	if len(os.Args) < 2 {
		fmt.Printf("clearvoiance %s\n", version)
		fmt.Println("usage: clearvoiance <command>")
		fmt.Println("commands will be added in Phase 1 (see plan/11-phase-1-capture-mvp.md)")
		return
	}

	switch os.Args[1] {
	case "version", "--version", "-v":
		fmt.Printf("clearvoiance %s\n", version)
	default:
		log.Error("unknown command", "arg", os.Args[1])
		os.Exit(1)
	}
}
