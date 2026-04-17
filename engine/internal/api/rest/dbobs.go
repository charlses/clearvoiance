package rest

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/go-chi/chi/v5"
)

// DB-observation endpoints power the UI's slow-query view. Back-end is the
// same db_observations ClickHouse table the db-observer writes to.

type slowQueryRow struct {
	ObservationType  string    `json:"observation_type"`
	EventID          string    `json:"event_id"`
	QueryFingerprint string    `json:"query_fingerprint"`
	QueryText        string    `json:"query_text"`
	Occurrences      uint64    `json:"occurrences"`
	AvgMs            float64   `json:"avg_ms"`
	P95Ms            float64   `json:"p95_ms"`
	MaxMs            float64   `json:"max_ms"`
	FirstObservedAt  time.Time `json:"first_observed_at"`
}

type dbByEndpointRow struct {
	HTTPMethod   string  `json:"http_method"`
	HTTPRoute    string  `json:"http_route"`
	Observations uint64  `json:"observations"`
	TotalDbMs    float64 `json:"total_db_ms"`
	AvgMs        float64 `json:"avg_ms"`
	MaxMs        float64 `json:"max_ms"`
}

func mountDbObservations(r chi.Router, d Deps) {
	h := &dbObsHandler{dsn: d.ClickhouseDSN}
	r.Route("/replays/{id}/db", func(r chi.Router) {
		r.Get("/top-slow-queries", h.topSlow)
		r.Get("/by-endpoint", h.byEndpoint)
	})
}

type dbObsHandler struct {
	dsn string
}

func (h *dbObsHandler) topSlow(w http.ResponseWriter, r *http.Request) {
	if h.dsn == "" {
		WriteError(w, http.StatusServiceUnavailable, "DB_OBSERVER_UNAVAILABLE",
			"engine has no ClickHouse DSN configured; DB observations are unavailable", nil)
		return
	}
	id := chi.URLParam(r, "id")
	limit := intQuery(r, "limit", 20)

	conn, err := openCH(r.Context(), h.dsn)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL", err.Error(), nil)
		return
	}
	defer conn.Close()

	if err := conn.Exec(r.Context(), bootstrapDbObservationsSchema); err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"ensure table: "+err.Error(), nil)
		return
	}

	rows, err := conn.Query(r.Context(), `
		SELECT
		  observation_type,
		  any(event_id),
		  query_fingerprint,
		  any(query_text),
		  count(),
		  round(avg(duration_ns) / 1e6, 2),
		  round(quantile(0.95)(duration_ns) / 1e6, 2),
		  round(max(duration_ns) / 1e6, 2),
		  fromUnixTimestamp64Nano(min(observed_at_ns))
		FROM db_observations
		WHERE replay_id = ?
		GROUP BY observation_type, query_fingerprint
		ORDER BY p95_ms DESC
		LIMIT ?
	`, id, uint64(limit))
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"query: "+err.Error(), nil)
		return
	}
	defer rows.Close()

	out := []slowQueryRow{}
	for rows.Next() {
		var row slowQueryRow
		if err := rows.Scan(
			&row.ObservationType, &row.EventID, &row.QueryFingerprint,
			&row.QueryText, &row.Occurrences, &row.AvgMs, &row.P95Ms, &row.MaxMs,
			&row.FirstObservedAt,
		); err != nil {
			WriteError(w, http.StatusInternalServerError, "INTERNAL",
				"scan: "+err.Error(), nil)
			return
		}
		out = append(out, row)
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"replay_id": id,
		"rows":      out,
	})
}

func (h *dbObsHandler) byEndpoint(w http.ResponseWriter, r *http.Request) {
	if h.dsn == "" {
		WriteError(w, http.StatusServiceUnavailable, "DB_OBSERVER_UNAVAILABLE",
			"engine has no ClickHouse DSN configured; DB observations are unavailable", nil)
		return
	}
	id := chi.URLParam(r, "id")
	limit := intQuery(r, "limit", 20)

	conn, err := openCH(r.Context(), h.dsn)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL", err.Error(), nil)
		return
	}
	defer conn.Close()

	if err := conn.Exec(r.Context(), bootstrapDbObservationsSchema); err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"ensure table: "+err.Error(), nil)
		return
	}

	rows, err := conn.Query(r.Context(), `
		SELECT
		  e.http_method,
		  if(e.http_route = '', e.http_path, e.http_route) AS route,
		  count(),
		  round(sum(o.duration_ns) / 1e6, 2),
		  round(avg(o.duration_ns) / 1e6, 2),
		  round(max(o.duration_ns) / 1e6, 2)
		FROM db_observations o
		INNER JOIN events e ON e.id = o.event_id
		WHERE o.replay_id = ?
		GROUP BY e.http_method, route
		ORDER BY sum(o.duration_ns) DESC
		LIMIT ?
	`, id, uint64(limit))
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"query: "+err.Error(), nil)
		return
	}
	defer rows.Close()

	out := []dbByEndpointRow{}
	for rows.Next() {
		var row dbByEndpointRow
		if err := rows.Scan(
			&row.HTTPMethod, &row.HTTPRoute, &row.Observations,
			&row.TotalDbMs, &row.AvgMs, &row.MaxMs,
		); err != nil {
			WriteError(w, http.StatusInternalServerError, "INTERNAL",
				"scan: "+err.Error(), nil)
			return
		}
		out = append(out, row)
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"replay_id": id,
		"rows":      out,
	})
}

const bootstrapDbObservationsSchema = `
CREATE TABLE IF NOT EXISTS db_observations (
    observation_id    String,
    replay_id         String,
    event_id          String,
    observation_type  LowCardinality(String),
    observed_at_ns    Int64,
    duration_ns       Int64,
    query_text        String CODEC(ZSTD(6)),
    query_fingerprint String,
    wait_event_type   LowCardinality(String),
    wait_event        String
) ENGINE = MergeTree()
PARTITION BY (replay_id)
ORDER BY (replay_id, event_id, observed_at_ns)
SETTINGS index_granularity = 8192;
`

func openCH(ctx context.Context, dsn string) (driver.Conn, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse clickhouse dsn: %w", err)
	}
	host := u.Host
	if !strings.Contains(host, ":") {
		host = host + ":9000"
	}
	opts := &clickhouse.Options{
		Addr: []string{host},
		Auth: clickhouse.Auth{
			Database: strings.TrimPrefix(u.Path, "/"),
		},
		DialTimeout: 5 * time.Second,
	}
	if opts.Auth.Database == "" {
		opts.Auth.Database = "default"
	}
	if u.User != nil {
		opts.Auth.Username = u.User.Username()
		if pw, ok := u.User.Password(); ok {
			opts.Auth.Password = pw
		}
	}
	conn, err := clickhouse.Open(opts)
	if err != nil {
		return nil, fmt.Errorf("clickhouse open: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := conn.Ping(pingCtx); err != nil {
		conn.Close()
		return nil, fmt.Errorf("clickhouse ping: %w", err)
	}
	return conn, nil
}
