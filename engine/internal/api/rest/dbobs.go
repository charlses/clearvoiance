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

	chstore "github.com/charlses/clearvoiance/engine/internal/storage/clickhouse"
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
		r.Get("/deadlocks", h.deadlocks)
		r.Get("/explain/{fingerprint}", h.explain)
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

	if err := conn.Exec(r.Context(), chstore.DbObservationsSchema); err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"ensure table: "+err.Error(), nil)
		return
	}

	rows, err := conn.Query(r.Context(), `
		SELECT
		  observation_type,
		  any(event_id)                                      AS event_id,
		  query_fingerprint,
		  any(query_text)                                    AS query_text,
		  count()                                            AS occurrences,
		  round(avg(duration_ns) / 1e6, 2)                   AS avg_ms,
		  round(quantile(0.95)(duration_ns) / 1e6, 2)        AS p95_ms,
		  round(max(duration_ns) / 1e6, 2)                   AS max_ms,
		  fromUnixTimestamp64Nano(min(observed_at_ns))       AS first_observed_at
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

	if err := conn.Exec(r.Context(), chstore.DbObservationsSchema); err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"ensure table: "+err.Error(), nil)
		return
	}

	// event_type != 'db' filter: SDK-emitted DbObservation events land in
	// the events table too (for stream durability) but they have empty
	// http_method/http_route. Without the filter the JOIN matches both
	// the originating HTTP event AND the DB events under the same id,
	// which inflates cardinality and drops most rows into an empty
	// (method,route) bucket.
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
		  AND e.event_type != 'db'
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

// deadlocks returns deadlock observations for a replay. Phase-4 core slice
// ships lock_wait events; true deadlock detection (pg_locks graph on
// deadlock_detected errors) is deferred — this endpoint returns an empty
// array + a `deferred` note until the observer emits those records, so
// the UI can render the panel as "no deadlocks observed" without special-
// casing 404.
func (h *dbObsHandler) deadlocks(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if h.dsn == "" {
		WriteError(w, http.StatusServiceUnavailable, "DB_OBSERVER_UNAVAILABLE",
			"engine has no ClickHouse DSN configured", nil)
		return
	}
	conn, err := openCH(r.Context(), h.dsn)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL", err.Error(), nil)
		return
	}
	defer conn.Close()
	if err := conn.Exec(r.Context(), chstore.DbObservationsSchema); err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"ensure table: "+err.Error(), nil)
		return
	}

	// Today: surface lock_wait observations as a proxy for deadlock
	// investigation. When the full lock-graph work lands (observer follow-
	// up), this endpoint gains the graph edges.
	rows, err := conn.Query(r.Context(), `
		SELECT event_id, query_fingerprint, any(query_text),
		       count(), round(avg(duration_ns) / 1e6, 2),
		       round(max(duration_ns) / 1e6, 2),
		       any(wait_event_type), any(wait_event)
		  FROM db_observations
		 WHERE replay_id = ? AND observation_type = 'lock_wait'
		 GROUP BY event_id, query_fingerprint
		 ORDER BY count() DESC
		 LIMIT ?
	`, id, uint64(intQuery(r, "limit", 50)))
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"query: "+err.Error(), nil)
		return
	}
	defer rows.Close()

	type lockWaitRow struct {
		EventID          string  `json:"event_id"`
		QueryFingerprint string  `json:"query_fingerprint"`
		QueryText        string  `json:"query_text"`
		Occurrences      uint64  `json:"occurrences"`
		AvgMs            float64 `json:"avg_ms"`
		MaxMs            float64 `json:"max_ms"`
		WaitEventType    string  `json:"wait_event_type"`
		WaitEvent        string  `json:"wait_event"`
	}
	out := []lockWaitRow{}
	for rows.Next() {
		var r lockWaitRow
		if err := rows.Scan(&r.EventID, &r.QueryFingerprint, &r.QueryText,
			&r.Occurrences, &r.AvgMs, &r.MaxMs,
			&r.WaitEventType, &r.WaitEvent); err != nil {
			WriteError(w, http.StatusInternalServerError, "INTERNAL",
				"scan: "+err.Error(), nil)
			return
		}
		out = append(out, r)
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"replay_id": id,
		"rows":      out,
		"note":      "full pg_locks deadlock graph lands with the observer log-tail follow-up; rows here are lock_wait observations as a proxy",
	})
}

// explain returns the captured EXPLAIN plan for a query fingerprint. Until
// the observer wires up auto_explain (deferred in Phase 4), this endpoint
// returns 501 with a pointer so UI clients know not to poll.
func (h *dbObsHandler) explain(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	fp := chi.URLParam(r, "fingerprint")
	WriteJSON(w, http.StatusNotImplemented, map[string]any{
		"replay_id":         id,
		"query_fingerprint": fp,
		"plan":              nil,
		"note":              "EXPLAIN plan capture requires the observer's auto_explain integration (deferred in Phase 4); see plan/14-phase-4-db-observer.md",
	})
}


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
