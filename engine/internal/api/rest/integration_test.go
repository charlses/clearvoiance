//go:build integration

// Real-Postgres integration for the REST API. Spins up Postgres via
// testcontainers, runs the full handler stack, and verifies:
//   - API keys created via POST /api-keys can be used as Bearer tokens
//   - Audit log rows land in Postgres for every write
//   - Revoking a key invalidates it (401 on next call)
//
// This is the "actually works" proof — everything else in rest_test.go
// uses the Noop metadata store and stops at handler plumbing.

package rest_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/charlses/clearvoiance/engine/internal/api/rest"
	"github.com/charlses/clearvoiance/engine/internal/replay"
	"github.com/charlses/clearvoiance/engine/internal/sessions"
	"github.com/charlses/clearvoiance/engine/internal/storage"
	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

func startPG(t *testing.T, ctx context.Context) string {
	t.Helper()
	c, err := tcpostgres.Run(ctx,
		"postgres:16-alpine",
		tcpostgres.WithDatabase("clv"),
		tcpostgres.WithUsername("clv"),
		tcpostgres.WithPassword("clv"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(60*time.Second),
		),
	)
	require.NoError(t, err)
	t.Cleanup(func() { _ = c.Terminate(ctx) })
	dsn, err := c.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)
	return dsn
}

func buildPGServer(t *testing.T) (*httptest.Server, *metadata.Postgres) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	t.Cleanup(cancel)

	dsn := startPG(t, ctx)
	pg, err := metadata.OpenPostgres(ctx, dsn)
	require.NoError(t, err)
	t.Cleanup(func() { _ = pg.Close() })

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	mgr := sessions.NewManager(pg.Sessions())
	re := replay.NewEngine(log, storage.Noop{}, storage.Noop{},
		pg.Replays(), nil)

	srv := httptest.NewServer(rest.Router(rest.Deps{
		Log:          log,
		Version:      "int-test",
		SessionMgr:   mgr,
		EventStore:   storage.Noop{},
		MetaStore:    pg,
		ReplayEngine: re,
		AuditLogger:  rest.NewPostgresAuditWriter(pg.Pool()),
	}))
	t.Cleanup(srv.Close)
	return srv, pg
}

// seedAPIKey inserts a key directly into Postgres and returns the
// plaintext. Replaces the dev-open bootstrap that these tests used to
// lean on — since dev-open is now gone, something has to prime the keys
// table before any authed handler call works.
func seedAPIKey(t *testing.T, pg *metadata.Postgres, name string) (id, plaintext string) {
	t.Helper()
	plaintext = "clv_live_" + name + "-seed-" + fmt.Sprint(time.Now().UnixNano())
	id = "key_seed_" + fmt.Sprint(time.Now().UnixNano())
	require.NoError(t,
		pg.APIKeys().Create(context.Background(), id, rest.HashAPIKey(plaintext), name),
	)
	return id, plaintext
}

func TestAPIKeys_RoundTripAgainstRealPostgres(t *testing.T) {
	srv, pg := buildPGServer(t)

	// Seed a bearer key directly — dev-open is gone, so something has
	// to prime the keys table before the first authed call works.
	_, seedKey := seedAPIKey(t, pg, "ci-seed")

	// Create a second key via the API using the seeded one as Bearer.
	code, body := doJSON(t, "POST", srv.URL+"/api/v1/api-keys",
		map[string]string{"name": "ci"},
		map[string]string{"Authorization": "Bearer " + seedKey})
	require.Equal(t, http.StatusCreated, code)
	var created map[string]any
	require.NoError(t, json.Unmarshal(body, &created))
	keyID := created["id"].(string)
	plainKey := created["key"].(string)
	require.NotEmpty(t, keyID)
	require.Contains(t, plainKey, "clv_live_")

	// The new key should also authenticate successfully.
	code, _ = doJSON(t, "GET", srv.URL+"/api/v1/sessions", nil,
		map[string]string{"Authorization": "Bearer " + plainKey})
	require.Equal(t, http.StatusOK, code)

	// An invalid key must 401.
	code, _ = doJSON(t, "GET", srv.URL+"/api/v1/sessions", nil,
		map[string]string{"Authorization": "Bearer bogus"})
	require.Equal(t, http.StatusUnauthorized, code)

	// Revoke via the API.
	code, _ = doJSON(t, "DELETE", srv.URL+"/api/v1/api-keys/"+keyID, nil,
		map[string]string{"Authorization": "Bearer " + plainKey})
	require.Equal(t, http.StatusNoContent, code)

	// The just-revoked key must no longer authenticate.
	code, _ = doJSON(t, "GET", srv.URL+"/api/v1/sessions", nil,
		map[string]string{"Authorization": "Bearer " + plainKey})
	require.Equal(t, http.StatusUnauthorized, code)

	// Audit log should have: (1) POST /api-keys, (2) DELETE /api-keys/{id}.
	// Audit writes are async so we poll briefly for eventual consistency.
	var count int
	for i := 0; i < 20; i++ {
		_ = pg.Pool().QueryRow(context.Background(),
			`SELECT count(*) FROM audit_log WHERE action LIKE '%api-keys%'`).
			Scan(&count)
		if count >= 2 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	require.GreaterOrEqual(t, count, 2,
		"audit log should have 2+ entries for api-keys writes, got %d", count)

	// Secret-ish fields were redacted. The POST /api-keys body carried
	// `name: "ci"`, no secrets; just verify the row shape is queryable.
	var (
		action     string
		targetType string
	)
	require.NoError(t,
		pg.Pool().QueryRow(context.Background(),
			`SELECT action, target_type FROM audit_log
			  WHERE action LIKE 'DELETE %' AND target_type = 'api-key'
			  ORDER BY ts DESC LIMIT 1`).
			Scan(&action, &targetType),
	)
	require.Contains(t, action, "DELETE")
}

func TestAudit_PayloadRedactsSecretFields(t *testing.T) {
	srv, pg := buildPGServer(t)

	// Seed a key directly so we have a valid Bearer for the write-
	// under-audit below.
	_, validKey := seedAPIKey(t, pg, "audit-seed")

	// Fire a POST /replays with a fake "secret_token" field; expect 400
	// (source_session_id missing) but the audit row … actually no — 400
	// doesn't audit. Fire a real valid request instead.
	code, _ := doJSON(t, "POST", srv.URL+"/api/v1/replays",
		map[string]any{
			"source_session_id": "sess_x",
			"target_url":        "http://example.com",
			"speedup":           1.0,
			"secret_token":      "should-be-redacted",
		},
		map[string]string{"Authorization": "Bearer " + validKey})
	require.Equal(t, http.StatusAccepted, code)

	// Give async audit write a moment.
	var payload []byte
	found := false
	for i := 0; i < 20; i++ {
		err := pg.Pool().QueryRow(context.Background(),
			`SELECT payload::text FROM audit_log
			  WHERE action = 'POST /api/v1/replays'
			  ORDER BY ts DESC LIMIT 1`).Scan(&payload)
		if err == nil {
			found = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	require.True(t, found, "no audit row for POST /api/v1/replays found")
	require.Contains(t, string(payload), "[REDACTED]",
		"expected secret_token to be redacted in audit payload, got: %s", payload)
}

func TestHealth_IsPublic(t *testing.T) {
	srv, _ := buildPGServer(t)
	// No Authorization header at all.
	resp, err := http.Get(srv.URL + "/api/v1/health")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	body, _ := io.ReadAll(resp.Body)
	require.Contains(t, string(body), "ok")
	_ = fmt.Sprintf
}
