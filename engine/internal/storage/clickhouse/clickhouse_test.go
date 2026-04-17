//go:build integration

// To run: `go test -tags=integration ./engine/internal/storage/clickhouse/...`
// Spins up a real ClickHouse container per run. Needs Docker.

package clickhouse

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	tcclickhouse "github.com/testcontainers/testcontainers-go/modules/clickhouse"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
)

func TestInsertBatch_RoundTrip(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	container, err := tcclickhouse.Run(ctx,
		"clickhouse/clickhouse-server:24-alpine",
		tcclickhouse.WithUsername("default"),
		tcclickhouse.WithPassword("dev"),
		tcclickhouse.WithDatabase("clearvoiance"),
	)
	require.NoError(t, err)
	t.Cleanup(func() {
		if err := container.Terminate(ctx); err != nil {
			t.Logf("terminate clickhouse: %v", err)
		}
	})

	host, err := container.Host(ctx)
	require.NoError(t, err)
	port, err := container.MappedPort(ctx, "9000/tcp")
	require.NoError(t, err)

	dsn := fmt.Sprintf("clickhouse://default:dev@%s:%s/clearvoiance", host, port.Port())
	store, err := Open(ctx, dsn)
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })

	sessionID := "sess_test_" + t.Name()
	events := []*pb.Event{
		{
			Id:          "ev1",
			SessionId:   sessionID,
			TimestampNs: time.Now().UnixNano(),
			Adapter:     "test",
			SdkVersion:  "test-0.0.0",
			Payload: &pb.Event_Http{
				Http: &pb.HttpEvent{
					Method:        "GET",
					Path:          "/hello/1",
					RouteTemplate: "/hello/:i",
					Status:        200,
					DurationNs:    500_000,
					SourceIp:      "127.0.0.1",
				},
			},
		},
		{
			Id:          "ev2",
			SessionId:   sessionID,
			TimestampNs: time.Now().UnixNano() + 1_000_000,
			Adapter:     "test",
			SdkVersion:  "test-0.0.0",
			Payload: &pb.Event_Cron{
				Cron: &pb.CronEvent{
					JobName:    "cleanup",
					Status:     "success",
					DurationNs: 12_000_000,
				},
			},
		},
	}

	require.NoError(t, store.InsertBatch(ctx, sessionID, events))

	// Verify rows landed with correct event_type mapping.
	row := store.conn.QueryRow(ctx,
		"SELECT count() FROM events WHERE session_id = ?",
		sessionID,
	)
	var count uint64
	require.NoError(t, row.Scan(&count))
	require.Equal(t, uint64(2), count)

	row = store.conn.QueryRow(ctx,
		"SELECT event_type FROM events WHERE id = ?",
		"ev1",
	)
	var httpType string
	require.NoError(t, row.Scan(&httpType))
	require.Equal(t, "http", httpType)

	row = store.conn.QueryRow(ctx,
		"SELECT event_type, cron_job FROM events WHERE id = ?",
		"ev2",
	)
	var cronType, cronJob string
	require.NoError(t, row.Scan(&cronType, &cronJob))
	require.Equal(t, "cron", cronType)
	require.Equal(t, "cleanup", cronJob)
}
