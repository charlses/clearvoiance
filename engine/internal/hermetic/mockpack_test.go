package hermetic

import (
	"context"
	"testing"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
)

// stubReader lets the test feed a canned slice of events into BuildMockPack
// without spinning up ClickHouse.
type stubReader struct {
	events []*pb.Event
	err    error
}

func (s *stubReader) ReadSession(ctx context.Context, _ string) (<-chan *pb.Event, <-chan error) {
	evCh := make(chan *pb.Event, len(s.events)+1)
	errCh := make(chan error, 1)
	for _, e := range s.events {
		evCh <- e
	}
	close(evCh)
	if s.err != nil {
		errCh <- s.err
	}
	close(errCh)
	return evCh, errCh
}

func TestBuildMockPack_EmitsOneEntryPerOutbound(t *testing.T) {
	reader := &stubReader{
		events: []*pb.Event{
			{
				Id:       "ev_1",
				Metadata: map[string]string{"host": "api.example.com"},
				Payload: &pb.Event_Http{
					Http: &pb.HttpEvent{Method: "POST", Path: "/inbound"},
				},
			},
			{
				Id:       "ev_2",
				Metadata: map[string]string{"host": "api.example.com"},
				Payload: &pb.Event_Outbound{
					Outbound: &pb.OutboundEvent{
						Target:           "example.com",
						CausedByEventId:  "ev_1",
						Http: &pb.HttpEvent{
							Method: "GET",
							Path:   "/v1/ping",
							Status: 200,
						},
					},
				},
			},
		},
	}

	var collected []*pb.MockEntry
	err := BuildMockPack(context.Background(), reader, "sess_test", func(e *pb.MockEntry) error {
		collected = append(collected, e)
		return nil
	})
	if err != nil {
		t.Fatalf("BuildMockPack: %v", err)
	}
	if len(collected) != 1 {
		t.Fatalf("want 1 entry (one outbound), got %d", len(collected))
	}
	got := collected[0]
	if got.CausedByEventId != "ev_1" {
		t.Errorf("causedBy: want ev_1, got %q", got.CausedByEventId)
	}
	if got.Status != 200 {
		t.Errorf("status: want 200, got %d", got.Status)
	}
	// Signature must match what the SDK computes for the same inputs.
	wantSig := SignatureOf("GET", "api.example.com", "/v1/ping", nil, "")
	if got.Signature != wantSig {
		t.Errorf("signature drift: want %q, got %q", wantSig, got.Signature)
	}
}

func TestBuildMockPack_SkipsNonOutboundEvents(t *testing.T) {
	reader := &stubReader{
		events: []*pb.Event{
			{Id: "a", Payload: &pb.Event_Http{Http: &pb.HttpEvent{}}},
			{Id: "b", Payload: &pb.Event_Cron{Cron: &pb.CronEvent{}}},
			{Id: "c", Payload: &pb.Event_Socket{Socket: &pb.SocketEvent{}}},
		},
	}
	var count int
	err := BuildMockPack(context.Background(), reader, "sess", func(*pb.MockEntry) error {
		count++
		return nil
	})
	if err != nil {
		t.Fatalf("BuildMockPack: %v", err)
	}
	if count != 0 {
		t.Fatalf("want 0 entries, got %d", count)
	}
}
