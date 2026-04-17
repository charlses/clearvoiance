package rest

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
)

// ConfigView is the read-only slice of the engine's runtime config we
// expose on GET /config. Secret-ish fields (any `_dsn` carrying credentials)
// are redacted before returning — same redaction policy as the audit log.
type ConfigView struct {
	Engine     string          `json:"engine"`
	Version    string          `json:"version"`
	GRPCAddr   string          `json:"grpc_addr,omitempty"`
	HTTPAddr   string          `json:"http_addr,omitempty"`
	Clickhouse string          `json:"clickhouse_dsn,omitempty"`
	Postgres   string          `json:"postgres_dsn,omitempty"`
	MinIO      string          `json:"minio_endpoint,omitempty"`
	Features   map[string]bool `json:"features,omitempty"`
}

func mountConfig(r chi.Router, view ConfigView) {
	view.Engine = "clearvoiance"
	view.Clickhouse = redactDSNCredentials(view.Clickhouse)
	view.Postgres = redactDSNCredentials(view.Postgres)
	r.Get("/config", func(w http.ResponseWriter, _ *http.Request) {
		WriteJSON(w, http.StatusOK, view)
	})
}

// redactDSNCredentials returns the DSN with user:pass replaced by `***`.
// Works for both clickhouse://user:pass@host:port/db and
// postgres://user:pass@host/db.
func redactDSNCredentials(dsn string) string {
	if dsn == "" {
		return ""
	}
	at := strings.LastIndex(dsn, "@")
	if at < 0 {
		return dsn
	}
	schemeEnd := strings.Index(dsn, "://")
	if schemeEnd < 0 || at <= schemeEnd+3 {
		return dsn
	}
	return dsn[:schemeEnd+3] + "***@" + dsn[at+1:]
}
