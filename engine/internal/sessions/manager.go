// Package sessions holds the lifecycle of capture sessions.
//
// Phase 1i adds an optional metadata store (Postgres) so session rows survive
// engine restart. Rolling counters stay in memory — we don't persist every
// event. On StreamEvents handshake for an unknown session, we rehydrate from
// the store so SDK-side WALs can drain after an engine bounce.
package sessions

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
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

// Manager stores sessions in memory keyed by ID and (optionally) mirrors
// lifecycle to a metadata store for durability across restart.
type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	store    metadata.Sessions
}

// NewManager constructs an empty session manager. Pass a metadata.Sessions
// (e.g. the Postgres-backed one) to persist lifecycle; otherwise use the
// in-memory default via NewInMemoryManager.
func NewManager(store metadata.Sessions) *Manager {
	return &Manager{
		sessions: make(map[string]*Session),
		store:    store,
	}
}

// NewInMemoryManager is the dev-smoke shortcut; sessions are lost on restart.
func NewInMemoryManager() *Manager {
	return NewManager(metadata.Noop{}.Sessions())
}

// Start opens a new active session, persists it, and returns it.
func (m *Manager) Start(ctx context.Context, req StartRequest) (*Session, error) {
	s := &Session{
		ID:        newID(),
		Name:      req.Name,
		Labels:    req.Labels,
		StartedAt: time.Now().UTC(),
		Status:    StatusActive,
	}

	if err := m.store.Create(ctx, metadata.SessionRow{
		ID:        s.ID,
		Name:      s.Name,
		Labels:    s.Labels,
		Status:    string(s.Status),
		StartedAt: s.StartedAt,
	}); err != nil {
		return nil, err
	}

	m.mu.Lock()
	m.sessions[s.ID] = s
	m.mu.Unlock()

	return s, nil
}

// ErrNotFound is returned when a session with the given ID does not exist.
var ErrNotFound = errors.New("session not found")

// ErrAlreadyStopped is returned when stopping an already stopped session.
var ErrAlreadyStopped = errors.New("session already stopped")

// Get returns the session by ID. If not in memory, attempts to rehydrate from
// the persistent store (so SDK WALs can drain after an engine restart). Only
// re-seeds when the row is still active.
func (m *Manager) Get(ctx context.Context, id string) (*Session, error) {
	m.mu.RLock()
	s, ok := m.sessions[id]
	m.mu.RUnlock()
	if ok {
		return s, nil
	}

	row, err := m.store.Get(ctx, id)
	if err != nil {
		if errors.Is(err, metadata.ErrSessionNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if row.Status != string(StatusActive) {
		return nil, ErrAlreadyStopped
	}

	// Rehydrate. Counters start at 0 in memory; persisted totals are read-only
	// for now and only update on Stop.
	hydrated := &Session{
		ID:        row.ID,
		Name:      row.Name,
		Labels:    row.Labels,
		StartedAt: row.StartedAt,
		Status:    StatusActive,
	}

	m.mu.Lock()
	// Check again under write lock — another handshake might have rehydrated.
	if existing, ok := m.sessions[id]; ok {
		m.mu.Unlock()
		return existing, nil
	}
	m.sessions[id] = hydrated
	m.mu.Unlock()

	return hydrated, nil
}

// Stop marks a session as stopped and returns its final state.
func (m *Manager) Stop(ctx context.Context, id string) (*Session, error) {
	m.mu.Lock()
	s, ok := m.sessions[id]
	if !ok {
		m.mu.Unlock()
		// Session might be alive in the store but not in memory (fresh restart,
		// nobody's handshaken yet). Fall through and consult the store.
		return m.stopPersisted(ctx, id)
	}
	if s.Status == StatusStopped {
		m.mu.Unlock()
		return nil, ErrAlreadyStopped
	}
	s.Status = StatusStopped
	s.StoppedAt = time.Now().UTC()
	m.mu.Unlock()

	if err := m.store.MarkStopped(ctx, id, s.StoppedAt,
		s.EventsCaptured.Load(), s.BytesCaptured.Load()); err != nil {
		return nil, err
	}
	return s, nil
}

func (m *Manager) stopPersisted(ctx context.Context, id string) (*Session, error) {
	row, err := m.store.Get(ctx, id)
	if err != nil {
		if errors.Is(err, metadata.ErrSessionNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if row.Status != string(StatusActive) {
		return nil, ErrAlreadyStopped
	}
	now := time.Now().UTC()
	if err := m.store.MarkStopped(ctx, id, now, row.EventsCaptured, row.BytesCaptured); err != nil {
		return nil, err
	}
	return &Session{
		ID:        row.ID,
		Name:      row.Name,
		Labels:    row.Labels,
		StartedAt: row.StartedAt,
		StoppedAt: now,
		Status:    StatusStopped,
	}, nil
}

// List returns a snapshot of sessions currently tracked in memory. For the
// full persisted list, query the metadata store directly.
func (m *Manager) List() []*Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, s)
	}
	return out
}

// RecordEvents bumps a session's in-memory counters.
func (m *Manager) RecordEvents(id string, count, bytes int64) bool {
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
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		panic(err)
	}
	return "sess_" + hex.EncodeToString(buf[:])
}
