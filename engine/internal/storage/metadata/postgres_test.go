//go:build integration

// Run with: `go test -tags=integration ./engine/internal/storage/metadata/...`
// Spins a real Postgres container; needs Docker.

package metadata

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
)

func openTestPostgres(t *testing.T, ctx context.Context) *Postgres {
	t.Helper()
	container, err := tcpostgres.Run(ctx,
		"postgres:16-alpine",
		tcpostgres.WithDatabase("clv"),
		tcpostgres.WithUsername("clv"),
		tcpostgres.WithPassword("clv"),
		tcpostgres.BasicWaitStrategies(),
	)
	require.NoError(t, err)
	t.Cleanup(func() {
		if err := container.Terminate(ctx); err != nil {
			t.Logf("terminate postgres: %v", err)
		}
	})

	dsn, err := container.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)

	store, err := OpenPostgres(ctx, dsn)
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func TestPostgresSessions_CreateGetMarkStopped(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	s := openTestPostgres(t, ctx).Sessions()

	row := SessionRow{
		ID:        "sess_test_" + t.Name(),
		Name:      "unit-test",
		Labels:    map[string]string{"env": "test", "team": "platform"},
		Status:    "active",
		StartedAt: time.Now().UTC().Truncate(time.Second),
	}
	require.NoError(t, s.Create(ctx, row))

	got, err := s.Get(ctx, row.ID)
	require.NoError(t, err)
	require.Equal(t, row.Name, got.Name)
	require.Equal(t, "active", got.Status)
	require.Equal(t, "test", got.Labels["env"])
	require.Equal(t, "platform", got.Labels["team"])
	require.Nil(t, got.StoppedAt)

	stoppedAt := time.Now().UTC().Truncate(time.Second)
	require.NoError(t, s.MarkStopped(ctx, row.ID, stoppedAt, 42, 4242))

	got, err = s.Get(ctx, row.ID)
	require.NoError(t, err)
	require.Equal(t, "stopped", got.Status)
	require.NotNil(t, got.StoppedAt)
	require.Equal(t, int64(42), got.EventsCaptured)
	require.Equal(t, int64(4242), got.BytesCaptured)
}

func TestPostgresSessions_GetMissing(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	s := openTestPostgres(t, ctx).Sessions()

	_, err := s.Get(ctx, "sess_does_not_exist")
	require.ErrorIs(t, err, ErrSessionNotFound)
}

func TestPostgresSessions_MarkStoppedMissing(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	s := openTestPostgres(t, ctx).Sessions()

	err := s.MarkStopped(ctx, "sess_missing", time.Now().UTC(), 0, 0)
	require.ErrorIs(t, err, ErrSessionNotFound)
}

func TestPostgresSessions_List(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	s := openTestPostgres(t, ctx).Sessions()

	for i, name := range []string{"a", "b", "c"} {
		_ = i
		require.NoError(t, s.Create(ctx, SessionRow{
			ID:        "sess_list_" + name,
			Name:      name,
			Status:    "active",
			StartedAt: time.Now().UTC().Add(time.Duration(i) * time.Second),
		}))
	}

	rows, err := s.List(ctx)
	require.NoError(t, err)
	require.Len(t, rows, 3)
	// DESC by started_at means "c" is first.
	require.Equal(t, "c", rows[0].Name)
}
