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
)

//go:embed schema.sql
var schemaSQL string

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
