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
	// PreferredID, when non-empty, forces Start to use that ID instead of
	// minting a new one. Used by ControlService: the dashboard pre-creates
	// a session row, pushes the ID down to the SDK, and the SDK's
	// StartSession RPC arrives here with PreferredID = that ID so the
	// engine attaches rather than creating a second session.
	//
	// If a session with this ID already exists, Start returns that session
	// unchanged (idempotent attach). If it doesn't exist, Start creates a
	// new session with the caller-supplied ID.
	PreferredID string
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

// Start opens a new active session, persists it, and returns it. When
// req.PreferredID matches a session that already exists in memory (the
// ControlService pre-create path), Start is idempotent — it returns
// that existing session without creating a second one. When it matches
// a row in the metadata store but not the in-memory map (e.g. engine
// restarted and the SDK is re-attaching), Start hydrates the row into
// the in-memory map and returns it.
func (m *Manager) Start(ctx context.Context, req StartRequest) (*Session, error) {
	if req.PreferredID != "" {
		m.mu.RLock()
		existing, ok := m.sessions[req.PreferredID]
		m.mu.RUnlock()
		if ok && existing.Status == StatusActive {
			return existing, nil
		}
		// Not in memory — might be a persisted row waiting for the SDK
		// to attach. Try to hydrate from the metadata store; ignore
		// ErrSessionNotFound, propagate anything else.
		row, err := m.store.Get(ctx, req.PreferredID)
		if err != nil && !errors.Is(err, metadata.ErrSessionNotFound) {
			return nil, err
		}
		if err == nil && row != nil {
			hydrated := &Session{
				ID:        row.ID,
				Name:      row.Name,
				Labels:    row.Labels,
				StartedAt: row.StartedAt,
				Status:    Status(row.Status),
			}
			if row.EventsCaptured > 0 {
				hydrated.EventsCaptured.Store(row.EventsCaptured)
			}
			if row.BytesCaptured > 0 {
				hydrated.BytesCaptured.Store(row.BytesCaptured)
			}
			m.mu.Lock()
			m.sessions[hydrated.ID] = hydrated
			m.mu.Unlock()
			if hydrated.Status == StatusActive {
				return hydrated, nil
			}
			// Row exists but is already stopped — fall through to
			// create a fresh session with a new ID (not the
			// PreferredID; stopped sessions can't be un-stopped).
		}
	}

	id := req.PreferredID
	if id == "" {
		id = newID()
	}
	s := &Session{
		ID:        id,
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

// TouchHeartbeat refreshes the session's last_heartbeat_at in the persistent
// store. In-memory state doesn't need updating — only the sweeper cares, and
// the sweeper reads Postgres.
func (m *Manager) TouchHeartbeat(ctx context.Context, id string) error {
	return m.store.Heartbeat(ctx, id)
}

// SweepIdle delegates to the metadata store's sweeper. Sessions closed by
// the sweeper are removed from the in-memory map too so subsequent ops don't
// see stale state.
func (m *Manager) SweepIdle(ctx context.Context, idle time.Duration) ([]string, error) {
	closed, err := m.store.SweepIdle(ctx, idle)
	if err != nil {
		return nil, err
	}
	if len(closed) > 0 {
		m.mu.Lock()
		for _, id := range closed {
			if s, ok := m.sessions[id]; ok {
				s.Status = StatusStopped
				if s.StoppedAt.IsZero() {
					s.StoppedAt = time.Now().UTC()
				}
			}
		}
		m.mu.Unlock()
	}
	return closed, nil
}

func newID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		panic(err)
	}
	return "sess_" + hex.EncodeToString(buf[:])
}
