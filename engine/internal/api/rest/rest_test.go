package rest_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/charlses/clearvoiance/engine/internal/api/rest"
	"github.com/charlses/clearvoiance/engine/internal/replay"
	"github.com/charlses/clearvoiance/engine/internal/sessions"
	"github.com/charlses/clearvoiance/engine/internal/storage"
	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

// testBearerKey is the plaintext API key the buildServer fixture seeds.
// sha256 of this is what lands in the in-memory metadata store.
const testBearerKey = "test-dev-key"

// buildServer wires a REST router against an in-memory metadata store
// with a pre-seeded API key (hash of testBearerKey) so Bearer auth works
// in tests. Users/UserSessions surfaces are also in-memory for the cookie
// auth tests. Postgres-specific paths (audit writer) have their own test.
func buildServer(t *testing.T) (*httptest.Server, metadata.Store) {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	meta := newTestMeta()
	// Seed one API key so Bearer auth works in every test.
	require.NoError(t, meta.APIKeys().Create(context.Background(),
		"key_test0001", rest.HashAPIKey(testBearerKey), "test"))
	mgr := sessions.NewManager(meta.Sessions())
	re := replay.NewEngine(log, storage.Noop{}, storage.Noop{},
		meta.Replays(), nil)

	srv := httptest.NewServer(rest.Router(rest.Deps{
		Log:          log,
		Version:      "test",
		SessionMgr:   mgr,
		EventStore:   storage.Noop{},
		MetaStore:    meta,
		ReplayEngine: re,
	}))
	t.Cleanup(srv.Close)
	return srv, meta
}

// testMeta wraps metadata.Noop but provides functional in-memory
// implementations of APIKeys, Users, UserSessions, and Monitors so
// auth and control-plane paths can be exercised without Postgres. The
// rest of the metadata surface stays Noop since the tests don't touch it.
type testMeta struct {
	metadata.Noop
	apiKeys      *memAPIKeys
	users        *memUsers
	userSessions *memUserSessions
	monitors     *memMonitors
}

func newTestMeta() *testMeta {
	return &testMeta{
		apiKeys:      &memAPIKeys{rows: map[string]metadata.APIKeyRow{}},
		users:        &memUsers{rows: map[string]metadata.UserRow{}},
		userSessions: &memUserSessions{rows: map[string]metadata.UserSessionRow{}},
		monitors:     &memMonitors{rows: map[string]metadata.MonitorRow{}},
	}
}

func (m *testMeta) APIKeys() metadata.APIKeys             { return m.apiKeys }
func (m *testMeta) Users() metadata.Users                 { return m.users }
func (m *testMeta) UserSessions() metadata.UserSessions   { return m.userSessions }
func (m *testMeta) Monitors() metadata.Monitors           { return m.monitors }

type memAPIKeys struct {
	mu   sync.Mutex
	rows map[string]metadata.APIKeyRow // keyed by hash
}

func (m *memAPIKeys) Create(_ context.Context, id, keyHash, name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rows[keyHash] = metadata.APIKeyRow{ID: id, Name: name, CreatedAt: time.Now()}
	return nil
}
func (m *memAPIKeys) ValidateHash(_ context.Context, keyHash string) (*metadata.APIKeyRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.rows[keyHash]
	if !ok || row.RevokedAt != nil {
		return nil, metadata.ErrAPIKeyNotFound
	}
	return &row, nil
}
func (m *memAPIKeys) Revoke(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for h, r := range m.rows {
		if r.ID == id {
			now := time.Now()
			r.RevokedAt = &now
			m.rows[h] = r
			return nil
		}
	}
	return metadata.ErrAPIKeyNotFound
}
func (m *memAPIKeys) List(_ context.Context) ([]metadata.APIKeyRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]metadata.APIKeyRow, 0, len(m.rows))
	for _, r := range m.rows {
		out = append(out, r)
	}
	return out, nil
}
func (m *memAPIKeys) Count(_ context.Context) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return int64(len(m.rows)), nil
}

type memUsers struct {
	mu   sync.Mutex
	rows map[string]metadata.UserRow // keyed by id
}

func (m *memUsers) Create(_ context.Context, row metadata.UserRow) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.rows {
		if r.Email == row.Email {
			return metadata.ErrUserAlreadyExists
		}
	}
	row.CreatedAt = time.Now()
	row.UpdatedAt = row.CreatedAt
	m.rows[row.ID] = row
	return nil
}
func (m *memUsers) GetByEmail(_ context.Context, email string) (*metadata.UserRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.rows {
		if r.Email == email {
			r := r
			return &r, nil
		}
	}
	return nil, metadata.ErrUserNotFound
}
func (m *memUsers) GetByID(_ context.Context, id string) (*metadata.UserRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[id]
	if !ok {
		return nil, metadata.ErrUserNotFound
	}
	return &r, nil
}
func (m *memUsers) UpdatePassword(_ context.Context, id, hash string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[id]
	if !ok {
		return metadata.ErrUserNotFound
	}
	r.PasswordHash = hash
	r.UpdatedAt = time.Now()
	m.rows[id] = r
	return nil
}
func (m *memUsers) TouchLogin(_ context.Context, id string, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[id]
	if !ok {
		return metadata.ErrUserNotFound
	}
	r.LastLoginAt = &at
	m.rows[id] = r
	return nil
}
func (m *memUsers) Count(_ context.Context) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return int64(len(m.rows)), nil
}

type memUserSessions struct {
	mu   sync.Mutex
	rows map[string]metadata.UserSessionRow // keyed by token hash
}

func (m *memUserSessions) Create(_ context.Context, row metadata.UserSessionRow) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rows[row.TokenHash] = row
	return nil
}
func (m *memUserSessions) Lookup(_ context.Context, hash string) (*metadata.UserSessionRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[hash]
	if !ok || r.ExpiresAt.Before(time.Now()) {
		return nil, metadata.ErrUserSessionNotFound
	}
	r.LastSeenAt = time.Now()
	m.rows[hash] = r
	return &r, nil
}
func (m *memUserSessions) Revoke(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for h, r := range m.rows {
		if r.ID == id {
			delete(m.rows, h)
			return nil
		}
	}
	return metadata.ErrUserSessionNotFound
}
func (m *memUserSessions) RevokeAllForUser(_ context.Context, userID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for h, r := range m.rows {
		if r.UserID == userID {
			delete(m.rows, h)
		}
	}
	return nil
}
func (m *memUserSessions) DeleteExpired(_ context.Context) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var n int64
	for h, r := range m.rows {
		if r.ExpiresAt.Before(time.Now()) {
			delete(m.rows, h)
			n++
		}
	}
	return n, nil
}

type memMonitors struct {
	mu   sync.Mutex
	rows map[string]metadata.MonitorRow // keyed by name
}

func (m *memMonitors) Upsert(_ context.Context, row metadata.MonitorRow) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	if existing, ok := m.rows[row.Name]; ok {
		// Preserve capture state across re-register — same semantics as pg.
		row.CaptureEnabled = existing.CaptureEnabled
		row.ActiveSessionID = existing.ActiveSessionID
		row.CreatedAt = existing.CreatedAt
	} else {
		row.CreatedAt = now
	}
	row.LastSeenAt = now
	row.UpdatedAt = now
	m.rows[row.Name] = row
	return nil
}
func (m *memMonitors) TouchLastSeen(_ context.Context, name string, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[name]
	if !ok {
		return metadata.ErrMonitorNotFound
	}
	r.LastSeenAt = at
	m.rows[name] = r
	return nil
}
func (m *memMonitors) Get(_ context.Context, name string) (*metadata.MonitorRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[name]
	if !ok {
		return nil, metadata.ErrMonitorNotFound
	}
	return &r, nil
}
func (m *memMonitors) List(_ context.Context) ([]metadata.MonitorRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]metadata.MonitorRow, 0, len(m.rows))
	for _, r := range m.rows {
		out = append(out, r)
	}
	return out, nil
}
func (m *memMonitors) SetCaptureState(_ context.Context, name string, enabled bool, sessionID *string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[name]
	if !ok {
		return metadata.ErrMonitorNotFound
	}
	r.CaptureEnabled = enabled
	r.ActiveSessionID = sessionID
	r.UpdatedAt = time.Now()
	m.rows[name] = r
	return nil
}

func doJSON(t *testing.T, method, url string, body any, headers map[string]string) (int, []byte) {
	t.Helper()
	var buf io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		require.NoError(t, err)
		buf = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, url, buf)
	require.NoError(t, err)
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	out, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	return resp.StatusCode, out
}

func authHeaders() map[string]string {
	return map[string]string{"Authorization": "Bearer " + testBearerKey}
}

func TestHealth_NoAuthRequired(t *testing.T) {
	srv, _ := buildServer(t)
	code, body := doJSON(t, "GET", srv.URL+"/api/v1/health", nil, nil)
	require.Equal(t, http.StatusOK, code)
	require.Contains(t, string(body), `"status":"ok"`)
}

func TestAuth_RejectsMissingBearer(t *testing.T) {
	srv, _ := buildServer(t)
	code, body := doJSON(t, "GET", srv.URL+"/api/v1/sessions", nil, nil)
	require.Equal(t, http.StatusUnauthorized, code)
	require.Contains(t, string(body), "UNAUTHENTICATED")
}

func TestAuth_AcceptsSeededBearerKey(t *testing.T) {
	srv, _ := buildServer(t)
	code, _ := doJSON(t, "GET", srv.URL+"/api/v1/sessions", nil, authHeaders())
	require.Equal(t, http.StatusOK, code)
}

func TestAuth_RejectsUnknownBearer(t *testing.T) {
	// Dev-open is gone: a bogus Bearer must 401 even though in-memory
	// store starts with a seeded test key (we're sending a different one).
	srv, _ := buildServer(t)
	code, body := doJSON(t, "GET", srv.URL+"/api/v1/sessions", nil,
		map[string]string{"Authorization": "Bearer not-the-test-key"})
	require.Equal(t, http.StatusUnauthorized, code)
	require.Contains(t, string(body), "UNAUTHENTICATED")
}

func TestSessions_ListEmpty(t *testing.T) {
	srv, _ := buildServer(t)
	code, body := doJSON(t, "GET", srv.URL+"/api/v1/sessions", nil, authHeaders())
	require.Equal(t, http.StatusOK, code)
	var got map[string]any
	require.NoError(t, json.Unmarshal(body, &got))
	require.Equal(t, float64(0), got["count"])
}

func TestSessions_Get404ForUnknownId(t *testing.T) {
	srv, _ := buildServer(t)
	code, body := doJSON(t, "GET", srv.URL+"/api/v1/sessions/nope", nil, authHeaders())
	require.Equal(t, http.StatusNotFound, code)
	require.Contains(t, string(body), "SESSION_NOT_FOUND")
}

func TestReplays_Start_RejectsMissingFields(t *testing.T) {
	srv, _ := buildServer(t)
	code, body := doJSON(t, "POST", srv.URL+"/api/v1/replays",
		map[string]any{}, authHeaders())
	require.Equal(t, http.StatusBadRequest, code)
	require.Contains(t, string(body), "source_session_id is required")
}

func TestReplays_Start_Happy202(t *testing.T) {
	srv, _ := buildServer(t)
	code, body := doJSON(t, "POST", srv.URL+"/api/v1/replays",
		map[string]any{
			"source_session_id": "sess_x",
			"target_url":        "http://example.com",
			"speedup":           1.0,
		},
		authHeaders())
	require.Equal(t, http.StatusAccepted, code)
	var resp map[string]any
	require.NoError(t, json.Unmarshal(body, &resp))
	require.Contains(t, resp["id"].(string), "rep_")
	require.Equal(t, "pending", resp["status"])
}

func TestReplays_Get404ForUnknownId(t *testing.T) {
	srv, _ := buildServer(t)
	code, body := doJSON(t, "GET", srv.URL+"/api/v1/replays/nope", nil, authHeaders())
	require.Equal(t, http.StatusNotFound, code)
	require.Contains(t, string(body), "REPLAY_NOT_FOUND")
}

func TestReplays_CancelUnknown404(t *testing.T) {
	srv, _ := buildServer(t)
	code, _ := doJSON(t, "POST", srv.URL+"/api/v1/replays/rep_missing/cancel",
		nil, authHeaders())
	require.Equal(t, http.StatusNotFound, code)
}

func TestAPIKeys_CRUD_WithNoopReturnsFriendlyFailure(t *testing.T) {
	// Noop APIKeys.Create returns nil (no-op). The CRUD roundtrip proves
	// the handler plumbing is correct; Postgres wiring is covered by the
	// integration test.
	srv, _ := buildServer(t)
	code, body := doJSON(t, "POST", srv.URL+"/api/v1/api-keys",
		map[string]any{"name": "ci-dev"}, authHeaders())
	require.Equal(t, http.StatusCreated, code)
	var created map[string]any
	require.NoError(t, json.Unmarshal(body, &created))
	require.Contains(t, created["key"].(string), "clv_live_")
	require.NotEmpty(t, created["id"])
}

func TestAPIKeys_CreateRejectsEmptyName(t *testing.T) {
	srv, _ := buildServer(t)
	code, _ := doJSON(t, "POST", srv.URL+"/api/v1/api-keys",
		map[string]any{"name": ""}, authHeaders())
	require.Equal(t, http.StatusBadRequest, code)
}

func TestOpenAPI_ServesSpec(t *testing.T) {
	srv, _ := buildServer(t)
	resp, err := http.Get(srv.URL + "/api/v1/openapi.yaml")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	body, _ := io.ReadAll(resp.Body)
	require.Contains(t, string(body), "openapi: 3.1.0")
	require.Contains(t, string(body), "clearvoiance Control Plane")
}

func TestSwaggerUI_ServesHTML(t *testing.T) {
	srv, _ := buildServer(t)
	resp, err := http.Get(srv.URL + "/docs")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, "text/html; charset=utf-8", resp.Header.Get("content-type"))
}

// --- dashboard auth flow ------------------------------------------------

// TestAuth_SetupFlow: when users is empty, POST /auth/setup provisions the
// sole admin, returns a session cookie, and subsequent /auth/me requests
// with the cookie return the user — no Bearer required.
func TestAuth_SetupFlow(t *testing.T) {
	srv, _ := buildServer(t)
	// With only one API key seeded in buildServer, users is still 0 — so
	// setup is available.
	client := &http.Client{}
	req, _ := http.NewRequest("GET", srv.URL+"/api/v1/auth/state", nil)
	resp, err := client.Do(req)
	require.NoError(t, err)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Contains(t, string(body), `"setup_required":true`)

	// Complete setup.
	setupPayload, _ := json.Marshal(map[string]string{
		"email":    "admin@example.com",
		"password": "hunter2-is-not-enough-but-this-is",
	})
	req, _ = http.NewRequest("POST", srv.URL+"/api/v1/auth/setup",
		bytes.NewReader(setupPayload))
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusCreated, resp.StatusCode)

	// Cookie should be set on the response.
	var sessionCookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == rest.SessionCookieName {
			sessionCookie = c
			break
		}
	}
	require.NotNil(t, sessionCookie)
	require.True(t, sessionCookie.HttpOnly)

	// /auth/me with the cookie should echo the admin back.
	req, _ = http.NewRequest("GET", srv.URL+"/api/v1/auth/me", nil)
	req.AddCookie(sessionCookie)
	resp, err = client.Do(req)
	require.NoError(t, err)
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Contains(t, string(body), "admin@example.com")

	// A second setup call must 409 — single-admin.
	req, _ = http.NewRequest("POST", srv.URL+"/api/v1/auth/setup",
		bytes.NewReader(setupPayload))
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusConflict, resp.StatusCode)
}

// TestAuth_LoginLogout: a set-up admin logs in via /auth/login, hits a
// protected endpoint with the cookie, then logs out — the cookie is
// revoked server-side so subsequent requests 401.
func TestAuth_LoginLogout(t *testing.T) {
	srv, meta := buildServer(t)
	// Pre-seed a user directly through the store so we skip the setup
	// wizard for this test.
	hash, err := rest.HashPassword("hunter2-is-not-enough-but-this-is",
		rest.DefaultArgon2idParams)
	require.NoError(t, err)
	require.NoError(t, meta.Users().Create(context.Background(), metadata.UserRow{
		ID: "user_test01", Email: "admin@example.com",
		PasswordHash: hash, Role: "admin",
	}))

	client := &http.Client{}
	loginPayload, _ := json.Marshal(map[string]string{
		"email":    "admin@example.com",
		"password": "hunter2-is-not-enough-but-this-is",
	})
	req, _ := http.NewRequest("POST", srv.URL+"/api/v1/auth/login",
		bytes.NewReader(loginPayload))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var sessionCookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == rest.SessionCookieName {
			sessionCookie = c
		}
	}
	require.NotNil(t, sessionCookie)

	// Cookie gets us past AuthMiddleware on /sessions without a Bearer.
	req, _ = http.NewRequest("GET", srv.URL+"/api/v1/sessions", nil)
	req.AddCookie(sessionCookie)
	resp, err = client.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	// Logout.
	req, _ = http.NewRequest("POST", srv.URL+"/api/v1/auth/logout", nil)
	req.AddCookie(sessionCookie)
	resp, err = client.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	// Cookie is now revoked — /sessions should 401 again.
	req, _ = http.NewRequest("GET", srv.URL+"/api/v1/sessions", nil)
	req.AddCookie(sessionCookie)
	resp, err = client.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// TestAuth_LoginWrongPassword: invalid creds get UNAUTHENTICATED with a
// deliberately-vague message so attackers can't enumerate emails.
func TestAuth_LoginWrongPassword(t *testing.T) {
	srv, meta := buildServer(t)
	hash, _ := rest.HashPassword("correct-horse-battery-staple",
		rest.DefaultArgon2idParams)
	require.NoError(t, meta.Users().Create(context.Background(), metadata.UserRow{
		ID: "user_test02", Email: "a@b.com", PasswordHash: hash, Role: "admin",
	}))

	payload, _ := json.Marshal(map[string]string{
		"email": "a@b.com", "password": "wrong",
	})
	code, body := doJSON(t, "POST", srv.URL+"/api/v1/auth/login",
		json.RawMessage(payload), nil)
	require.Equal(t, http.StatusUnauthorized, code)
	require.Contains(t, string(body), "invalid email or password")
}
