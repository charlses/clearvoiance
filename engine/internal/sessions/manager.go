// Package sessions holds the lifecycle of capture sessions.
//
// Phase 1a: pure in-memory. ClickHouse + Postgres-backed persistence
// land in Phase 1b (see plan/11-phase-1-capture-mvp.md).
package sessions

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"sync/atomic"
	"time"
)

// Status is a capture session's lifecycle state.
type Status string

const (
	StatusActive  Status = "active"
	StatusStopped Status = "stopped"
)

// Session is a single capture window.
type Session struct {
	ID        string
	Name      string
	Labels    map[string]string
	StartedAt time.Time
	StoppedAt time.Time
	Status    Status

	// Rolling counters updated as events arrive. Safe for concurrent readers
	// via atomic; writers are the ingest path.
	EventsCaptured atomic.Int64
	BytesCaptured  atomic.Int64
}

// StartRequest captures the fields a caller supplies when opening a session.
type StartRequest struct {
	Name   string
	Labels map[string]string
}

// Manager stores sessions in memory keyed by ID.
type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Session
}

// NewManager constructs an empty session manager.
func NewManager() *Manager {
	return &Manager{sessions: make(map[string]*Session)}
}

// Start opens a new active session and returns it.
func (m *Manager) Start(req StartRequest) *Session {
	s := &Session{
		ID:        newID(),
		Name:      req.Name,
		Labels:    req.Labels,
		StartedAt: time.Now().UTC(),
		Status:    StatusActive,
	}

	m.mu.Lock()
	m.sessions[s.ID] = s
	m.mu.Unlock()

	return s
}

// ErrNotFound is returned when a session with the given ID does not exist.
var ErrNotFound = errors.New("session not found")

// ErrAlreadyStopped is returned when stopping an already stopped session.
var ErrAlreadyStopped = errors.New("session already stopped")

// Get returns the session by ID or ErrNotFound.
func (m *Manager) Get(id string) (*Session, error) {
	m.mu.RLock()
	s, ok := m.sessions[id]
	m.mu.RUnlock()
	if !ok {
		return nil, ErrNotFound
	}
	return s, nil
}

// Stop marks a session as stopped and returns its final state.
func (m *Manager) Stop(id string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	s, ok := m.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}
	if s.Status == StatusStopped {
		return nil, ErrAlreadyStopped
	}
	s.Status = StatusStopped
	s.StoppedAt = time.Now().UTC()
	return s, nil
}

// List returns a snapshot of all known sessions. Order is not guaranteed.
func (m *Manager) List() []*Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, s)
	}
	return out
}

// RecordEvents bumps a session's counters. Safe to call concurrently.
// Returns false if the session is unknown.
func (m *Manager) RecordEvents(id string, count int64, bytes int64) bool {
	m.mu.RLock()
	s, ok := m.sessions[id]
	m.mu.RUnlock()
	if !ok {
		return false
	}
	s.EventsCaptured.Add(count)
	s.BytesCaptured.Add(bytes)
	return true
}

func newID() string {
	// 16 random bytes → 32 hex chars. Stable enough for v1; swap to UUIDv7
	// when we persist (Phase 1b) so IDs sort by time.
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// crypto/rand failing on Linux means the kernel is broken;
		// there's no sensible recovery.
		panic(err)
	}
	return "sess_" + hex.EncodeToString(buf[:])
}
