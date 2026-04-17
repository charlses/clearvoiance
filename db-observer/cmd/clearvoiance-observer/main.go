// Command clearvoiance-observer polls the SUT's Postgres and correlates
// slow queries / lock waits to the replay events that caused them.
//
// See plan/14-phase-4-db-observer.md. Run as sidecar or embed in the engine.
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/charlses/clearvoiance/db-observer/internal/cli"
)

var version = "0.0.0-dev"

func main() {
	root := cli.NewRootCmd(version)
	if err := root.ExecuteContext(context.Background()); err != nil {
		fmt.Fprintf(os.Stderr, "clearvoiance-observer: %v\n", err)
		os.Exit(1)
	}
}
