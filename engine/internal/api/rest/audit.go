package rest

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// AuditEntry is one row in the audit_log table.
type AuditEntry struct {
	ID         string
	Timestamp  time.Time
	APIKeyID   string
	Action     string
	TargetType string
	TargetID   string
	Payload    json.RawMessage
	SourceIP   string
}

// AuditWriter is the persistence shape the middleware depends on. Keeps
// the audit log decoupled from the concrete Postgres implementation so
// tests can swap in a memory sink.
type AuditWriter interface {
	WriteEntry(ctx context.Context, entry AuditEntry) error
}

// AuditMiddleware wraps every write request (POST/PUT/PATCH/DELETE) with an
// audit_log insert after the handler runs. GETs are never audited.
func AuditMiddleware(sink AuditWriter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !isWriteMethod(r.Method) {
				next.ServeHTTP(w, r)
				return
			}

			// Buffer the body so we can both feed it through to the handler
			// and snapshot it for audit. Capped by ReadJSON's 1MB limit.
			var capturedBody []byte
			if r.Body != nil {
				const cap = 1 << 20
				buf, err := io.ReadAll(io.LimitReader(r.Body, cap))
				if err == nil {
					capturedBody = buf
					r.Body = io.NopCloser(bytes.NewReader(buf))
				}
			}

			rw := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rw, r)

			// Only audit on success (2xx/3xx). 4xx/5xx aren't mutations
			// we care to log — they didn't change state.
			if rw.status >= 400 {
				return
			}

			entry := AuditEntry{
				ID:         uuid.NewString(),
				Timestamp:  time.Now().UTC(),
				APIKeyID:   apiKeyID(r.Context()),
				Action:     r.Method + " " + r.URL.Path,
				TargetType: targetTypeFromPath(r.URL.Path),
				TargetID:   targetIDFromPath(r.URL.Path),
				Payload:    redactPayload(capturedBody),
				SourceIP:   clientIP(r),
			}
			// Fire-and-forget; audit failure should never block the
			// response. Using a detached context so client disconnect
			// doesn't abort the insert.
			bgCtx := context.WithoutCancel(r.Context())
			go func() {
				_ = sink.WriteEntry(bgCtx, entry)
			}()
		})
	}
}

// statusRecorder captures the HTTP status the handler wrote.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func isWriteMethod(m string) bool {
	return m == http.MethodPost || m == http.MethodPut ||
		m == http.MethodPatch || m == http.MethodDelete
}

// targetTypeFromPath turns /api/v1/sessions/{id}/stop into "session".
func targetTypeFromPath(p string) string {
	parts := strings.Split(strings.Trim(p, "/"), "/")
	// parts = [api, v1, <resource>, ...]
	if len(parts) >= 3 {
		return strings.TrimSuffix(parts[2], "s")
	}
	return ""
}

// targetIDFromPath pulls the id segment out when the path is
// /api/v1/<resource>/<id>[/<subresource>].
func targetIDFromPath(p string) string {
	parts := strings.Split(strings.Trim(p, "/"), "/")
	if len(parts) >= 4 {
		return parts[3]
	}
	return ""
}

// apiKeyID returns the validated API key id attached by AuthMiddleware,
// or "" under dev-open.
func apiKeyID(ctx context.Context) string {
	if r := APIKeyFromCtx(ctx); r != nil {
		return r.ID
	}
	return "dev-open"
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if comma := strings.IndexByte(xff, ','); comma > 0 {
			return strings.TrimSpace(xff[:comma])
		}
		return strings.TrimSpace(xff)
	}
	return strings.Split(r.RemoteAddr, ":")[0]
}

// redactPayload strips obvious secret-ish fields from a JSON body before
// it's persisted. Keeps the audit log useful for debugging without turning
// it into a credential leak.
func redactPayload(body []byte) json.RawMessage {
	if len(body) == 0 {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		return nil
	}
	for k := range m {
		lk := strings.ToLower(k)
		if strings.Contains(lk, "token") ||
			strings.Contains(lk, "password") ||
			strings.Contains(lk, "secret") ||
			strings.Contains(lk, "api_key") ||
			lk == "key" {
			m[k] = "[REDACTED]"
		}
	}
	out, err := json.Marshal(m)
	if err != nil {
		return nil
	}
	return out
}

// PostgresAuditWriter writes audit_log rows into the metadata Postgres.
type PostgresAuditWriter struct {
	pool *pgxpool.Pool
}

// NewPostgresAuditWriter wires a writer against an existing pgxpool.
func NewPostgresAuditWriter(pool *pgxpool.Pool) *PostgresAuditWriter {
	return &PostgresAuditWriter{pool: pool}
}

// The audit_log table DDL lives in engine/internal/storage/metadata/
// postgres_schema.sql and is applied idempotently on engine startup.
// Nothing here needs to carry a duplicate constant — the schema file is
// the single source of truth.

func (w *PostgresAuditWriter) WriteEntry(ctx context.Context, e AuditEntry) error {
	_, err := w.pool.Exec(ctx, `
		INSERT INTO audit_log (id, ts, api_key_id, action, target_type, target_id, payload, source_ip)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	`, e.ID, e.Timestamp, e.APIKeyID, e.Action, e.TargetType, e.TargetID,
		e.Payload, e.SourceIP)
	return err
}
