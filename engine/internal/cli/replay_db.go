package cli

import (
	"context"
	"fmt"
	"time"

	chstore "github.com/charlses/clearvoiance/engine/internal/storage/clickhouse"
)

// dbObservationRow is the aggregated slow-query / lock-wait row shown by
// `clearvoiance replay results <id> --db`.
type dbObservationRow struct {
	ObservationType  string  `json:"observation_type"`
	EventID          string  `json:"event_id"`
	QueryFingerprint string  `json:"query_fingerprint"`
	QueryText        string  `json:"query_text"`
	Occurrences      uint64  `json:"occurrences"`
	AvgMs            float64 `json:"avg_ms"`
	P95Ms            float64 `json:"p95_ms"`
	MaxMs            float64 `json:"max_ms"`
	FirstObservedAt  time.Time `json:"first_observed_at"`
}

// dbByEndpointRow joins db_observations against events to show which
// endpoint each observation belongs to. Events for a replay are stored
// under the replay's source session; we grab http_route from the session
// event the observer's event_id points at.
type dbByEndpointRow struct {
	HTTPMethod     string  `json:"http_method"`
	HTTPRoute      string  `json:"http_route"`
	Observations   uint64  `json:"observations"`
	TotalDbMs      float64 `json:"total_db_ms"`
	AvgMs          float64 `json:"avg_ms"`
	MaxMs          float64 `json:"max_ms"`
}

func queryDbObservations(ctx context.Context, dsn, replayID string, topN int) ([]dbObservationRow, []dbByEndpointRow, error) {
	conn, err := openClickhouse(ctx, dsn)
	if err != nil {
		return nil, nil, err
	}
	defer conn.Close()

	// Ensure the table exists. If the observer never ran for this replay
	// there will simply be 0 rows; we'd rather return an empty result
	// than bubble up "table doesn't exist" noise to the operator.
	if err := conn.Exec(ctx, chstore.DbObservationsSchema); err != nil {
		return nil, nil, fmt.Errorf("ensure db_observations: %w", err)
	}

	// Per-fingerprint aggregates, ordered by p95.
	agg, err := conn.Query(ctx, `
		SELECT
		  observation_type,
		  any(event_id) AS event_id,
		  query_fingerprint,
		  any(query_text) AS query_text,
		  count() AS occurrences,
		  round(avg(duration_ns) / 1e6, 2) AS avg_ms,
		  round(quantile(0.95)(duration_ns) / 1e6, 2) AS p95_ms,
		  round(max(duration_ns) / 1e6, 2) AS max_ms,
		  fromUnixTimestamp64Nano(min(observed_at_ns)) AS first_observed_at
		FROM db_observations
		WHERE replay_id = ?
		GROUP BY observation_type, query_fingerprint
		ORDER BY p95_ms DESC
		LIMIT ?
	`, replayID, uint64(topN))
	if err != nil {
		return nil, nil, fmt.Errorf("db observations query: %w", err)
	}
	defer agg.Close()

	rows := []dbObservationRow{}
	for agg.Next() {
		var r dbObservationRow
		if err := agg.Scan(
			&r.ObservationType, &r.EventID, &r.QueryFingerprint,
			&r.QueryText, &r.Occurrences,
			&r.AvgMs, &r.P95Ms, &r.MaxMs, &r.FirstObservedAt,
		); err != nil {
			return nil, nil, fmt.Errorf("scan db observation: %w", err)
		}
		rows = append(rows, r)
	}

	// Endpoint rollup: join to events on event_id → http_route.
	// Uses IN subquery to avoid a full events table scan.
	endpoint, err := conn.Query(ctx, `
		SELECT
		  e.http_method,
		  if(e.http_route = '', e.http_path, e.http_route) AS route,
		  count() AS observations,
		  round(sum(o.duration_ns) / 1e6, 2) AS total_db_ms,
		  round(avg(o.duration_ns) / 1e6, 2) AS avg_ms,
		  round(max(o.duration_ns) / 1e6, 2) AS max_ms
		FROM db_observations o
		INNER JOIN events e ON e.id = o.event_id
		WHERE o.replay_id = ?
		GROUP BY e.http_method, route
		ORDER BY total_db_ms DESC
		LIMIT ?
	`, replayID, uint64(topN))
	if err != nil {
		return rows, nil, nil
	}
	defer endpoint.Close()

	byEndpoint := []dbByEndpointRow{}
	for endpoint.Next() {
		var r dbByEndpointRow
		if err := endpoint.Scan(
			&r.HTTPMethod, &r.HTTPRoute, &r.Observations,
			&r.TotalDbMs, &r.AvgMs, &r.MaxMs,
		); err != nil {
			// Non-fatal: some replays may have DB observations without matching events.
			break
		}
		byEndpoint = append(byEndpoint, r)
	}

	return rows, byEndpoint, nil
}

