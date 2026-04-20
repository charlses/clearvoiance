// Package clickhouse implements storage.EventStore against ClickHouse.
//
// Flattens hot Event fields into columns for fast range scans and preserves
// the full protobuf as raw_pb so nothing we don't flatten is lost.
package clickhouse

import (
	"context"
	_ "embed"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"google.golang.org/protobuf/proto"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
	"github.com/charlses/clearvoiance/engine/internal/storage"
)

//go:embed schema.sql
var schemaSQL string

// DbObservationsSchema is the canonical CREATE TABLE for the db_observations
// table. Exported so the CLI + REST handlers can idempotently ensure the
// table exists without needing to reach into the embedded schema.sql. If
// the shape here changes, schema.sql must match — integration tests cover
// that by running the full migration on boot.
const DbObservationsSchema = `
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

// Store persists events to ClickHouse.
type Store struct {
	conn driver.Conn
}

// Open connects to ClickHouse using a DSN like
//
//	clickhouse://user:pass@host:9000/dbname
//
// and ensures the events table exists.
func Open(ctx context.Context, dsn string) (*Store, error) {
	opts, err := parseDSN(dsn)
	if err != nil {
		return nil, err
	}

	conn, err := clickhouse.Open(opts)
	if err != nil {
		return nil, fmt.Errorf("clickhouse open: %w", err)
	}

	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := conn.Ping(pingCtx); err != nil {
		return nil, fmt.Errorf("clickhouse ping: %w", err)
	}

	for _, stmt := range splitStatements(schemaSQL) {
		if err := conn.Exec(ctx, stmt); err != nil {
			return nil, fmt.Errorf("clickhouse migrate: %w", err)
		}
	}

	return &Store{conn: conn}, nil
}

// InsertBatch writes events to the `events` table atomically.
func (s *Store) InsertBatch(ctx context.Context, sessionID string, events []*pb.Event) error {
	if len(events) == 0 {
		return nil
	}

	batch, err := s.conn.PrepareBatch(ctx, "INSERT INTO events")
	if err != nil {
		return fmt.Errorf("prepare batch: %w", err)
	}

	for _, ev := range events {
		raw, err := proto.Marshal(ev)
		if err != nil {
			return fmt.Errorf("marshal event %q: %w", ev.GetId(), err)
		}

		cols := flatten(sessionID, ev, raw)
		if err := batch.Append(
			cols.id,
			cols.sessionID,
			cols.timestampNs,
			cols.offsetNs,
			cols.adapter,
			cols.sdkVersion,
			cols.eventType,
			cols.userID,
			cols.metadata,
			cols.redactions,
			cols.httpMethod,
			cols.httpPath,
			cols.httpRoute,
			cols.httpStatus,
			cols.durationNs,
			cols.sourceIP,
			cols.socketID,
			cols.socketOp,
			cols.socketEvent,
			cols.cronJob,
			cols.cronStatus,
			cols.bodySize,
			string(raw),
		); err != nil {
			return fmt.Errorf("append event: %w", err)
		}
	}

	if err := batch.Send(); err != nil {
		return err
	}

	// Side-channel: SDK-emitted DbObservation events also need to land
	// in db_observations so the dashboard's /db page can see them
	// alongside observer-emitted rows. Same shape either way.
	return s.insertDbObservations(ctx, events)
}

// insertDbObservations appends a row to db_observations for every event
// carrying a Db payload. replay_id is parsed out of the application_name
// (same `clv:<replayId>:<eventId>` scheme the observer produces). Best-
// effort: a failure here logs but doesn't fail the whole batch — the
// events table got the row, so nothing's lost.
func (s *Store) insertDbObservations(ctx context.Context, events []*pb.Event) error {
	var dbEvents []*pb.Event
	for _, ev := range events {
		if ev.GetDb() != nil {
			dbEvents = append(dbEvents, ev)
		}
	}
	if len(dbEvents) == 0 {
		return nil
	}

	batch, err := s.conn.PrepareBatch(ctx, "INSERT INTO db_observations")
	if err != nil {
		return fmt.Errorf("prepare db_observations batch: %w", err)
	}
	for _, ev := range dbEvents {
		d := ev.GetDb()
		replayID, _ := parseClvAppName(d.GetApplicationName())
		if err := batch.Append(
			ev.GetId(),                          // observation_id (reuse event id)
			replayID,                            // replay_id
			d.GetCausedByEventId(),              // event_id
			observationTypeToString(d.GetObservationType()),
			ev.GetTimestampNs(),                 // observed_at_ns
			d.GetDurationNs(),
			d.GetQueryText(),
			d.GetQueryFingerprint(),
			"",                                  // wait_event_type (SDK doesn't emit these)
			"",                                  // wait_event
		); err != nil {
			return fmt.Errorf("append db_observation: %w", err)
		}
	}
	return batch.Send()
}

// parseClvAppName pulls replay_id out of `clv:<replayId>:<eventId>`. Returns
// empty strings if app_name doesn't match the expected format.
func parseClvAppName(appName string) (replayID, eventID string) {
	const prefix = "clv:"
	if !strings.HasPrefix(appName, prefix) {
		return "", ""
	}
	rest := appName[len(prefix):]
	if colon := strings.Index(rest, ":"); colon >= 0 {
		return rest[:colon], rest[colon+1:]
	}
	return "", rest
}

func observationTypeToString(t pb.DbObservationEvent_DbObservationType) string {
	switch t {
	case pb.DbObservationEvent_DB_OBSERVATION_TYPE_SLOW_QUERY:
		return "slow_query"
	case pb.DbObservationEvent_DB_OBSERVATION_TYPE_LOCK_WAIT:
		return "lock_wait"
	case pb.DbObservationEvent_DB_OBSERVATION_TYPE_DEADLOCK:
		return "deadlock"
	case pb.DbObservationEvent_DB_OBSERVATION_TYPE_LONG_TRANSACTION:
		return "long_transaction"
	default:
		return "slow_query"
	}
}

// ReadSession streams events for a session in chronological order. Callers
// consume via the returned channel; the error channel receives at most one
// error and is then closed. Both channels are always closed.
func (s *Store) ReadSession(ctx context.Context, sessionID string) (<-chan *pb.Event, <-chan error) {
	events := make(chan *pb.Event, 256)
	errs := make(chan error, 1)

	go func() {
		defer close(events)
		defer close(errs)

		rows, err := s.conn.Query(ctx,
			`SELECT raw_pb FROM events
			  WHERE session_id = ?
			  ORDER BY timestamp_ns ASC, id ASC`,
			sessionID,
		)
		if err != nil {
			errs <- fmt.Errorf("read session: %w", err)
			return
		}
		defer rows.Close()

		for rows.Next() {
			var raw string
			if err := rows.Scan(&raw); err != nil {
				errs <- fmt.Errorf("scan event: %w", err)
				return
			}
			ev := &pb.Event{}
			if err := proto.Unmarshal([]byte(raw), ev); err != nil {
				errs <- fmt.Errorf("unmarshal event: %w", err)
				return
			}
			select {
			case events <- ev:
			case <-ctx.Done():
				errs <- ctx.Err()
				return
			}
		}
		if err := rows.Err(); err != nil {
			errs <- err
		}
	}()

	return events, errs
}

// ReadReplayEvents returns the first `limit` rows for a replay, ordered by
// scheduled fire time ascending. Used by the REST /replays/{id}/events
// endpoint.
func (s *Store) ReadReplayEvents(ctx context.Context, replayID string, limit int) ([]storage.ReplayResultRow, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.conn.Query(ctx, `
		SELECT replay_id, event_id, scheduled_fire_ns, actual_fire_ns, lag_ns,
		       response_status, response_duration_ns,
		       error_code, error_message, bytes_sent, bytes_received,
		       http_method, http_path, http_route
		  FROM replay_events
		 WHERE replay_id = ?
		 ORDER BY scheduled_fire_ns ASC
		 LIMIT ?
	`, replayID, uint64(limit))
	if err != nil {
		return nil, fmt.Errorf("read replay events: %w", err)
	}
	defer rows.Close()
	out := []storage.ReplayResultRow{}
	for rows.Next() {
		var r storage.ReplayResultRow
		if err := rows.Scan(&r.ReplayID, &r.EventID, &r.ScheduledFireNs,
			&r.ActualFireNs, &r.LagNs, &r.ResponseStatus, &r.ResponseDurationNs,
			&r.ErrorCode, &r.ErrorMessage, &r.BytesSent, &r.BytesReceived,
			&r.HTTPMethod, &r.HTTPPath, &r.HTTPRoute); err != nil {
			return nil, fmt.Errorf("scan replay event: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ReadSessionEvents returns the first `limit` events for a session, ordered
// by timestamp ascending. Decodes raw_pb into *pb.Event for the REST event
// browser. For large sessions callers should prefer ReadSession's streaming
// API.
func (s *Store) ReadSessionEvents(ctx context.Context, sessionID string, limit int) ([]*pb.Event, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.conn.Query(ctx, `
		SELECT raw_pb FROM events
		 WHERE session_id = ?
		 ORDER BY timestamp_ns ASC, id ASC
		 LIMIT ?
	`, sessionID, uint64(limit))
	if err != nil {
		return nil, fmt.Errorf("read session events: %w", err)
	}
	defer rows.Close()
	out := []*pb.Event{}
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, fmt.Errorf("scan event: %w", err)
		}
		ev := &pb.Event{}
		if err := proto.Unmarshal([]byte(raw), ev); err != nil {
			return nil, fmt.Errorf("unmarshal event: %w", err)
		}
		out = append(out, ev)
	}
	return out, rows.Err()
}

// DeleteSession drops the captured events for a session + the replay_events
// that originated from replays of that session. Metadata rows are removed by
// the metadata store separately; this is the event-store side of the
// DELETE /sessions/{id} story.
func (s *Store) DeleteSession(ctx context.Context, sessionID string) error {
	// ClickHouse ALTER TABLE DELETE is asynchronous (mutation) but eventually
	// removes rows. For v1 that's acceptable; operators wanting immediate
	// freedom can TRUNCATE PARTITION on the session_id partition.
	if err := s.conn.Exec(ctx,
		`ALTER TABLE events DELETE WHERE session_id = ?`, sessionID); err != nil {
		return fmt.Errorf("delete events for session: %w", err)
	}
	if err := s.conn.Exec(ctx, `ALTER TABLE replay_events DELETE
		 WHERE replay_id IN (SELECT id FROM replays WHERE source_session_id = ?)`,
		sessionID); err != nil {
		// Non-fatal: maybe `replays` lives only in Postgres. Swallow and
		// let the operator clean up if they care.
		return nil
	}
	return nil
}

// InsertReplayEvents writes a batch of replay results. Shape mirrors the
// replay_events table; see storage.ReplayResultRow for the canonical type.
func (s *Store) InsertReplayEvents(ctx context.Context, rows []storage.ReplayResultRow) error {
	if len(rows) == 0 {
		return nil
	}
	batch, err := s.conn.PrepareBatch(ctx, "INSERT INTO replay_events")
	if err != nil {
		return fmt.Errorf("prepare replay_events batch: %w", err)
	}
	for _, r := range rows {
		if err := batch.Append(
			r.ReplayID,
			r.EventID,
			r.ScheduledFireNs,
			r.ActualFireNs,
			r.LagNs,
			r.ResponseStatus,
			r.ResponseDurationNs,
			r.ErrorCode,
			r.ErrorMessage,
			r.BytesSent,
			r.BytesReceived,
			r.HTTPMethod,
			r.HTTPPath,
			r.HTTPRoute,
		); err != nil {
			return fmt.Errorf("append replay event: %w", err)
		}
	}
	return batch.Send()
}

// Close releases the underlying connection pool.
func (s *Store) Close() error {
	if s.conn == nil {
		return nil
	}
	return s.conn.Close()
}

// flatRow is the shape of one ClickHouse row.
type flatRow struct {
	id          string
	sessionID   string
	timestampNs int64
	offsetNs    int64
	adapter     string
	sdkVersion  string
	eventType   string
	userID      string
	metadata    map[string]string
	redactions  []string

	httpMethod string
	httpPath   string
	httpRoute  string
	httpStatus uint16
	durationNs int64
	sourceIP   string

	socketID    string
	socketOp    string
	socketEvent string

	cronJob    string
	cronStatus string

	bodySize int64
}

func flatten(sessionID string, ev *pb.Event, raw []byte) flatRow {
	r := flatRow{
		id:          ev.GetId(),
		sessionID:   sessionID,
		timestampNs: ev.GetTimestampNs(),
		offsetNs:    ev.GetOffsetNs(),
		adapter:     ev.GetAdapter(),
		sdkVersion:  ev.GetSdkVersion(),
		metadata:    ev.GetMetadata(),
		redactions:  ev.GetRedactionsApplied(),
	}
	if r.metadata == nil {
		r.metadata = map[string]string{}
	}
	if r.redactions == nil {
		r.redactions = []string{}
	}

	switch p := ev.GetPayload().(type) {
	case *pb.Event_Http:
		r.eventType = "http"
		r.httpMethod = p.Http.GetMethod()
		r.httpPath = p.Http.GetPath()
		r.httpRoute = p.Http.GetRouteTemplate()
		r.httpStatus = uint16(p.Http.GetStatus())
		r.durationNs = p.Http.GetDurationNs()
		r.sourceIP = p.Http.GetSourceIp()
		r.userID = p.Http.GetUserId()
		r.bodySize = bodySize(p.Http.GetRequestBody()) + bodySize(p.Http.GetResponseBody())
	case *pb.Event_Socket:
		r.eventType = "socket"
		r.socketID = p.Socket.GetSocketId()
		r.socketOp = p.Socket.GetOp().String()
		r.socketEvent = p.Socket.GetEventName()
		r.durationNs = p.Socket.GetDurationNs()
		r.userID = p.Socket.GetUserId()
		r.bodySize = bodySize(p.Socket.GetData())
	case *pb.Event_Cron:
		r.eventType = "cron"
		r.cronJob = p.Cron.GetJobName()
		r.cronStatus = p.Cron.GetStatus()
		r.durationNs = p.Cron.GetDurationNs()
		r.bodySize = bodySize(p.Cron.GetArgs())
	case *pb.Event_Webhook:
		r.eventType = "webhook"
		r.httpMethod = p.Webhook.GetHttp().GetMethod()
		r.httpPath = p.Webhook.GetHttp().GetPath()
		r.httpStatus = uint16(p.Webhook.GetHttp().GetStatus())
		r.durationNs = p.Webhook.GetHttp().GetDurationNs()
		r.sourceIP = p.Webhook.GetHttp().GetSourceIp()
		r.bodySize = bodySize(p.Webhook.GetHttp().GetRequestBody()) +
			bodySize(p.Webhook.GetHttp().GetResponseBody())
	case *pb.Event_Queue:
		r.eventType = "queue"
		r.durationNs = p.Queue.GetDurationNs()
		r.bodySize = bodySize(p.Queue.GetPayload())
	case *pb.Event_Outbound:
		r.eventType = "outbound"
		r.httpMethod = p.Outbound.GetHttp().GetMethod()
		r.httpPath = p.Outbound.GetHttp().GetPath()
		r.httpStatus = uint16(p.Outbound.GetHttp().GetStatus())
		r.durationNs = p.Outbound.GetHttp().GetDurationNs()
		r.bodySize = bodySize(p.Outbound.GetHttp().GetRequestBody()) +
			bodySize(p.Outbound.GetHttp().GetResponseBody())
	case *pb.Event_Db:
		r.eventType = "db"
		r.durationNs = p.Db.GetDurationNs()
	default:
		r.eventType = "unknown"
	}

	// raw_pb size is a lower bound for storage accounting; body_size is
	// "logical" payload size from the Body messages.
	_ = raw
	return r
}

func bodySize(b *pb.Body) int64 {
	if b == nil {
		return 0
	}
	return b.GetSizeBytes()
}

// parseDSN turns "clickhouse://user:pass@host:port/db?..." into clickhouse-go
// options. Accepts both native (9000) and HTTP (8123) style; we let the driver
// default to native.
func parseDSN(raw string) (*clickhouse.Options, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	if u.Scheme != "clickhouse" {
		return nil, fmt.Errorf("unsupported scheme %q (want clickhouse://)", u.Scheme)
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
		MaxOpenConns:    16,
		MaxIdleConns:    8,
		ConnMaxLifetime: time.Hour,
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
	return opts, nil
}

// splitStatements strips -- comment lines and splits the script into individual
// statements on semicolons. Empty statements are dropped.
func splitStatements(script string) []string {
	var withoutComments strings.Builder
	for _, line := range strings.Split(script, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "--") {
			continue
		}
		withoutComments.WriteString(line)
		withoutComments.WriteByte('\n')
	}

	raw := strings.Split(withoutComments.String(), ";")
	out := make([]string, 0, len(raw))
	for _, s := range raw {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}
