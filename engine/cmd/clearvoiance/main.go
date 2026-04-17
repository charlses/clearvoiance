// Command clearvoiance is the CLI and engine entry point.
package main

import (
	"os"

	"github.com/charlses/clearvoiance/engine/internal/cli"
)

// version is set at build time via -ldflags "-X main.version=..."
var version = "0.0.0-dev"

func main() {
	if err := cli.Execute(version); err != nil {
		os.Exit(1)
	}
}
