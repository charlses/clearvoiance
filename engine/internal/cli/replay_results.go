package cli

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
)

// replayEndpointRow mirrors the shape returned by the per-endpoint query.
type replayEndpointRow struct {
	HTTPMethod  string  `json:"http_method"`
	HTTPRoute   string  `json:"http_route"`
	Requests    uint64  `json:"requests"`
	Errors5xx   uint64  `json:"errors_5xx"`
	ErrorsOther uint64  `json:"errors_other"`
	AvgMs       float64 `json:"avg_ms"`
	P50Ms       float64 `json:"p50_ms"`
	P95Ms       float64 `json:"p95_ms"`
	P99Ms       float64 `json:"p99_ms"`
	MaxMs       float64 `json:"max_ms"`
}

type replaySummary struct {
	TotalRequests uint64  `json:"total_requests"`
	TotalErrors   uint64  `json:"total_errors"`
	ErrorRate     float64 `json:"error_rate"`
	AvgMs         float64 `json:"avg_ms"`
	P95Ms         float64 `json:"p95_ms"`
	P99Ms         float64 `json:"p99_ms"`
	MaxLagMs      float64 `json:"max_lag_ms"`
}

func queryReplayResults(ctx context.Context, dsn, replayID string, topN int) ([]replayEndpointRow, *replaySummary, error) {
	conn, err := openClickhouse(ctx, dsn)
	if err != nil {
		return nil, nil, err
	}
	defer conn.Close()

	// Per-endpoint aggregates.
	perEndpoint, err := conn.Query(ctx, `
		SELECT
		  http_method,
		  http_route,
		  count() AS requests,
		  sum(response_status >= 500) AS errors_5xx,
		  sum(error_code != '' AND response_status < 500) AS errors_other,
		  round(avg(response_duration_ns) / 1e6, 2) AS avg_ms,
		  round(quantile(0.5)(response_duration_ns) / 1e6, 2) AS p50_ms,
		  round(quantile(0.95)(response_duration_ns) / 1e6, 2) AS p95_ms,
		  round(quantile(0.99)(response_duration_ns) / 1e6, 2) AS p99_ms,
		  round(max(response_duration_ns) / 1e6, 2) AS max_ms
		FROM replay_events
		WHERE replay_id = ?
		GROUP BY http_method, http_route
		ORDER BY p95_ms DESC
		LIMIT ?
	`, replayID, uint64(topN))
	if err != nil {
		return nil, nil, fmt.Errorf("per-endpoint query: %w", err)
	}
	defer perEndpoint.Close()

	rows := []replayEndpointRow{}
	for perEndpoint.Next() {
		var r replayEndpointRow
		if err := perEndpoint.Scan(
			&r.HTTPMethod, &r.HTTPRoute, &r.Requests,
			&r.Errors5xx, &r.ErrorsOther,
			&r.AvgMs, &r.P50Ms, &r.P95Ms, &r.P99Ms, &r.MaxMs,
		); err != nil {
			return nil, nil, fmt.Errorf("scan per-endpoint row: %w", err)
		}
		rows = append(rows, r)
	}

	// Overall summary.
	sumRow := conn.QueryRow(ctx, `
		SELECT
		  count() AS total,
		  sum(response_status >= 500 OR error_code != '') AS errors,
		  round(avg(response_duration_ns) / 1e6, 2) AS avg_ms,
		  round(quantile(0.95)(response_duration_ns) / 1e6, 2) AS p95_ms,
		  round(quantile(0.99)(response_duration_ns) / 1e6, 2) AS p99_ms,
		  round(max(lag_ns) / 1e6, 2) AS max_lag_ms
		FROM replay_events
		WHERE replay_id = ?
	`, replayID)
	var s replaySummary
	if err := sumRow.Scan(&s.TotalRequests, &s.TotalErrors,
		&s.AvgMs, &s.P95Ms, &s.P99Ms, &s.MaxLagMs); err != nil {
		return nil, nil, fmt.Errorf("summary query: %w", err)
	}
	if s.TotalRequests > 0 {
		s.ErrorRate = float64(s.TotalErrors) / float64(s.TotalRequests)
	}
	return rows, &s, nil
}

// openClickhouse parses a clearvoiance-style DSN and opens a connection.
// Copy of the one in storage/clickhouse but local to cli to avoid dragging
// the storage package into the CLI-only read path.
func openClickhouse(ctx context.Context, dsn string) (clickhouse.Conn, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse clickhouse dsn: %w", err)
	}
	host := u.Host
	if _, _, err := net.SplitHostPort(host); err != nil {
		host = net.JoinHostPort(host, "9000")
	}
	opts := &clickhouse.Options{
		Addr: []string{host},
		Auth: clickhouse.Auth{
			Database: strings.TrimPrefix(u.Path, "/"),
		},
		DialTimeout:     5 * time.Second,
		ConnMaxLifetime: 10 * time.Minute,
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
