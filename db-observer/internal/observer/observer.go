// Package observer polls pg_stat_activity for SUT queries carrying a
// `clv:<event_id>` application_name and emits DbObservation records that
// correlate slow queries back to the replay event that caused them.
//
// See plan/14-phase-4-db-observer.md for the full design. This package
// covers the pg_stat_activity path; log-tail / auto_explain / lock-graph
// are follow-up slices.
package observer

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Observation is one record emitted by the poller. Observation IDs are
// assigned by the sink (so deduping across observer restarts is the sink's
// responsibility).
type Observation struct {
	// Replay correlation.
	ReplayID string
	EventID  string
	// Observation metadata.
	Type         ObservationType
	ObservedAt   time.Time
	DurationNs   int64
	// Query identity.
	QueryText        string
	QueryFingerprint string
	// Wait / lock metadata, when applicable.
	WaitEventType string
	WaitEvent     string
}

// ObservationType is the kind of DB observation emitted.
type ObservationType string

const (
	ObservationTypeSlowQuery ObservationType = "slow_query"
	ObservationTypeLockWait  ObservationType = "lock_wait"
)

// Sink is where the poller sends observations. One impl per deployment
// target: ClickHouse, stdout (dev), noop (tests).
type Sink interface {
	Emit(ctx context.Context, obs Observation) error
	Close() error
}

// Config parameterizes the observer.
type Config struct {
	// Postgres DSN of the SUT's DB. READ-ONLY user with pg_stat_activity access.
	PostgresDSN string
	// How often to snapshot pg_stat_activity. Default 100ms.
	PollInterval time.Duration
	// Queries slower than this threshold emit a SlowQuery observation.
	// Default 100ms.
	SlowQueryThresholdMs int64
	// Prefix the SDK set on application_name. Default "clv:".
	AppPrefix string
}

// Default values. Exposed so tests can reference them.
const (
	DefaultPollInterval         = 100 * time.Millisecond
	DefaultSlowQueryThresholdMs = 100
	DefaultAppPrefix            = "clv:"
)

// Observer is the long-running poll loop.
type Observer struct {
	log    *slog.Logger
	cfg    Config
	pool   *pgxpool.Pool
	sink   Sink

	// Debounce: pid → last observed snapshot, to avoid emitting a new
	// observation every poll for the same in-flight query.
	debounce map[int32]debounceRow
}

type debounceRow struct {
	appName    string
	queryStart time.Time
	emitted    bool
}

// New constructs an Observer. Pool is dialed but polling starts on Run.
func New(ctx context.Context, log *slog.Logger, cfg Config, sink Sink) (*Observer, error) {
	if cfg.PostgresDSN == "" {
		return nil, errors.New("observer: postgres DSN is required")
	}
	if cfg.PollInterval == 0 {
		cfg.PollInterval = DefaultPollInterval
	}
	if cfg.SlowQueryThresholdMs == 0 {
		cfg.SlowQueryThresholdMs = DefaultSlowQueryThresholdMs
	}
	if cfg.AppPrefix == "" {
		cfg.AppPrefix = DefaultAppPrefix
	}

	poolCfg, err := pgxpool.ParseConfig(cfg.PostgresDSN)
	if err != nil {
		return nil, fmt.Errorf("observer: parse DSN: %w", err)
	}
	// We don't want the observer's own connection in pg_stat_activity to
	// look like a captured event — tag it distinctly so it's easy to filter.
	poolCfg.ConnConfig.RuntimeParams["application_name"] = "clv-observer"
	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, fmt.Errorf("observer: open pool: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("observer: ping: %w", err)
	}

	return &Observer{
		log:      log,
		cfg:      cfg,
		pool:     pool,
		sink:     sink,
		debounce: make(map[int32]debounceRow),
	}, nil
}

// Close releases the pool and sink.
func (o *Observer) Close() error {
	if o.pool != nil {
		o.pool.Close()
	}
	if o.sink != nil {
		return o.sink.Close()
	}
	return nil
}

// Run loops polling + emitting until ctx is done. Each poll runs in a
// bounded time slice; a single failure just logs and continues.
func (o *Observer) Run(ctx context.Context) error {
	tick := time.NewTicker(o.cfg.PollInterval)
	defer tick.Stop()

	o.log.Info("observer running",
		"poll_interval", o.cfg.PollInterval,
		"slow_threshold_ms", o.cfg.SlowQueryThresholdMs,
		"app_prefix", o.cfg.AppPrefix,
	)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-tick.C:
			o.tick(ctx)
		}
	}
}

// tick runs a single pg_stat_activity poll and emits any new observations.
// Kept separate so tests can drive it deterministically without waiting
// for the ticker.
func (o *Observer) tick(ctx context.Context) {
	queryCtx, cancel := context.WithTimeout(ctx, o.cfg.PollInterval*2)
	defer cancel()

	rows, err := o.pool.Query(queryCtx, `
		SELECT
			pid,
			application_name,
			state,
			query_start,
			wait_event_type,
			wait_event,
			query
		FROM pg_stat_activity
		WHERE application_name LIKE $1
		  AND state IS DISTINCT FROM 'idle'
		  AND pid <> pg_backend_pid()
	`, o.cfg.AppPrefix+"%")
	if err != nil {
		o.log.Warn("pg_stat_activity query failed", "err", err)
		return
	}
	defer rows.Close()

	now := time.Now().UTC()
	seen := make(map[int32]struct{})

	for rows.Next() {
		var (
			pid           int32
			appName       string
			state         string
			queryStart    *time.Time
			waitEventType *string
			waitEvent     *string
			queryText     string
		)
		if err := rows.Scan(&pid, &appName, &state, &queryStart, &waitEventType, &waitEvent, &queryText); err != nil {
			o.log.Warn("pg_stat_activity scan failed", "err", err)
			continue
		}
		seen[pid] = struct{}{}

		parsed := ParseAppName(appName, o.cfg.AppPrefix)
		if parsed == nil {
			continue
		}

		// Debounce: only emit once per (pid, query_start) pair. If the
		// debounce row has a different query_start, it's a new query on
		// the same pid → emit again.
		prev, hasPrev := o.debounce[pid]
		sameQuery := hasPrev && prev.appName == appName && queryStart != nil && prev.queryStart.Equal(*queryStart)

		var duration time.Duration
		if queryStart != nil {
			duration = now.Sub(*queryStart)
		}

		threshold := time.Duration(o.cfg.SlowQueryThresholdMs) * time.Millisecond

		var obsType ObservationType
		switch {
		case waitEventType != nil && *waitEventType == "Lock":
			obsType = ObservationTypeLockWait
		case duration >= threshold:
			obsType = ObservationTypeSlowQuery
		default:
			// Not yet slow and not lock-waiting — track it so we emit once
			// it crosses the threshold.
			o.debounce[pid] = debounceRow{
				appName:    appName,
				queryStart: deref(queryStart, now),
				emitted:    false,
			}
			continue
		}

		if sameQuery && prev.emitted {
			// Already emitted this query; skip until it ends or a new
			// query starts on this pid.
			continue
		}

		obs := Observation{
			ReplayID:         parsed.ReplayID,
			EventID:          parsed.EventID,
			Type:             obsType,
			ObservedAt:       now,
			DurationNs:       duration.Nanoseconds(),
			QueryText:        queryText,
			QueryFingerprint: Fingerprint(queryText),
			WaitEventType:    deref(waitEventType, ""),
			WaitEvent:        deref(waitEvent, ""),
		}
		if err := o.sink.Emit(ctx, obs); err != nil {
			o.log.Warn("sink emit failed",
				"err", err,
				"event_id", obs.EventID,
				"type", obs.Type,
			)
			continue
		}

		o.debounce[pid] = debounceRow{
			appName:    appName,
			queryStart: deref(queryStart, now),
			emitted:    true,
		}
	}

	if err := rows.Err(); err != nil {
		o.log.Warn("pg_stat_activity rows err", "err", err)
	}

	// Drop debounce entries whose pid isn't in this poll anymore — the
	// query completed, they can be re-observed if the pid runs another.
	for pid := range o.debounce {
		if _, ok := seen[pid]; !ok {
			delete(o.debounce, pid)
		}
	}
}

// ParseApp is exported for tests + log-tail reuse.
type ParsedAppName struct {
	ReplayID string
	EventID  string
}

// ParseAppName pulls the event/replay ids out of `clv:...` application names.
// Returns nil for anything that doesn't match the SDK's format.
func ParseAppName(appName, prefix string) *ParsedAppName {
	if !strings.HasPrefix(appName, prefix) {
		return nil
	}
	tail := appName[len(prefix):]
	if tail == "" {
		return nil
	}
	if colon := strings.IndexByte(tail, ':'); colon >= 0 {
		return &ParsedAppName{
			ReplayID: tail[:colon],
			EventID:  tail[colon+1:],
		}
	}
	return &ParsedAppName{EventID: tail}
}

// Fingerprint is a cheap stable hash of a query string for grouping. We
// normalize whitespace + strip literal numbers/strings so `SELECT 1` and
// `SELECT 2` share a fingerprint. Not as robust as pg_stat_statements'
// query ID but good enough for UI grouping.
func Fingerprint(query string) string {
	cleaned := strings.Join(strings.Fields(stripLiterals(query)), " ")
	sum := sha1.Sum([]byte(cleaned))
	return hex.EncodeToString(sum[:])[:16]
}

func stripLiterals(s string) string {
	// Replace string literals with `?`.
	var b strings.Builder
	b.Grow(len(s))
	i := 0
	for i < len(s) {
		c := s[i]
		switch {
		case c == '\'':
			// skip to next unescaped '
			j := i + 1
			for j < len(s) {
				if s[j] == '\'' {
					if j+1 < len(s) && s[j+1] == '\'' {
						j += 2
						continue
					}
					break
				}
				j++
			}
			b.WriteByte('?')
			i = j + 1
		case c >= '0' && c <= '9':
			for i < len(s) && (s[i] == '.' || (s[i] >= '0' && s[i] <= '9')) {
				i++
			}
			b.WriteByte('?')
		default:
			b.WriteByte(c)
			i++
		}
	}
	return b.String()
}

func deref[T any](p *T, zero T) T {
	if p == nil {
		return zero
	}
	return *p
}
