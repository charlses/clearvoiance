package sink

import (
	"context"
	"sync"

	"github.com/charlses/clearvoiance/db-observer/internal/observer"
)

// Memory is an in-process sink used by tests + the `--print` dev mode. All
// observations are retained in insertion order; snapshot via Observations().
type Memory struct {
	mu   sync.Mutex
	rows []observer.Observation
}

func NewMemory() *Memory {
	return &Memory{}
}

func (m *Memory) Emit(_ context.Context, obs observer.Observation) error {
	m.mu.Lock()
	m.rows = append(m.rows, obs)
	m.mu.Unlock()
	return nil
}

func (m *Memory) Observations() []observer.Observation {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]observer.Observation, len(m.rows))
	copy(out, m.rows)
	return out
}

func (m *Memory) Clear() {
	m.mu.Lock()
	m.rows = nil
	m.mu.Unlock()
}

func (*Memory) Close() error { return nil }
