package sink

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/charlses/clearvoiance/db-observer/internal/observer"
)

// Stdout emits observations as NDJSON to stdout. Useful for dev loops —
// pipe into `jq` for quick exploration without ClickHouse.
type Stdout struct {
	mu sync.Mutex
}

func NewStdout() *Stdout { return &Stdout{} }

func (s *Stdout) Emit(_ context.Context, obs observer.Observation) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	line := map[string]any{
		"observed_at":       obs.ObservedAt.Format(time.RFC3339Nano),
		"replay_id":         obs.ReplayID,
		"event_id":          obs.EventID,
		"observation_type":  string(obs.Type),
		"duration_ms":       obs.DurationNs / int64(time.Millisecond),
		"query_fingerprint": obs.QueryFingerprint,
		"query_text":        obs.QueryText,
		"wait_event_type":   obs.WaitEventType,
		"wait_event":        obs.WaitEvent,
	}
	buf, err := json.Marshal(line)
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stdout, string(buf))
	return nil
}

func (*Stdout) Close() error { return nil }
