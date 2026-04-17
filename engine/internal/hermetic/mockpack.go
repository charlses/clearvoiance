package hermetic

import (
	"context"
	"fmt"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
	"github.com/charlses/clearvoiance/engine/internal/storage"
)

// EventReader is the minimum Store surface the mock-pack builder needs.
// Kept narrow so tests can stub it without a live ClickHouse.
type EventReader interface {
	ReadSession(ctx context.Context, sessionID string) (<-chan *pb.Event, <-chan error)
}

// BuildMockPack reads every outbound event for a session and streams
// MockEntry rows back to the caller. Emits one MockEntry per captured
// outbound; duplicates (same event + signature) are preserved so the
// SDK's mock store can cycle through them at replay time.
func BuildMockPack(
	ctx context.Context,
	store EventReader,
	sessionID string,
	emit func(*pb.GetMockPackResponse) error,
) error {
	events, errs := store.ReadSession(ctx, sessionID)
	if events == nil {
		return fmt.Errorf("mockpack: nil event channel for session %q", sessionID)
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-errs:
			if err != nil {
				return fmt.Errorf("mockpack read: %w", err)
			}
		case ev, ok := <-events:
			if !ok {
				// Drain any buffered error before returning.
				select {
				case err := <-errs:
					return err
				default:
					return nil
				}
			}
			entry, ok := entryFromEvent(ev)
			if !ok {
				continue
			}
			if err := emit(entry); err != nil {
				return err
			}
		}
	}
}

// entryFromEvent builds a MockEntry from a captured OutboundEvent. Returns
// (nil, false) for non-outbound events.
func entryFromEvent(ev *pb.Event) (*pb.GetMockPackResponse, bool) {
	outbound := ev.GetOutbound()
	if outbound == nil {
		return nil, false
	}
	httpEv := outbound.GetHttp()
	if httpEv == nil {
		return nil, false
	}

	host := ev.GetMetadata()["host"]
	if host == "" {
		host = outbound.GetTarget()
	}

	reqBody := inlineBytes(httpEv.GetRequestBody())
	reqContentType := contentTypeOf(httpEv.GetRequestBody())
	sig := SignatureOf(
		httpEv.GetMethod(),
		host,
		httpEv.GetPath(),
		reqBody,
		reqContentType,
	)

	resBody := inlineBytes(httpEv.GetResponseBody())
	resContentType := contentTypeOf(httpEv.GetResponseBody())

	// Convert proto HeaderValues map → the MockEntry-local HeaderValuesM map.
	resHeaders := make(map[string]*pb.HeaderValuesM, len(httpEv.GetResponseHeaders()))
	for k, v := range httpEv.GetResponseHeaders() {
		resHeaders[k] = &pb.HeaderValuesM{Values: v.GetValues()}
	}

	return &pb.GetMockPackResponse{
		CausedByEventId:     outbound.GetCausedByEventId(),
		Signature:           sig,
		Status:              httpEv.GetStatus(),
		ResponseHeaders:     resHeaders,
		ResponseBody:        resBody,
		ResponseContentType: resContentType,
	}, true
}

func inlineBytes(b *pb.Body) []byte {
	if b == nil {
		return nil
	}
	return b.GetInline()
}

func contentTypeOf(b *pb.Body) string {
	if b == nil {
		return ""
	}
	return b.GetContentType()
}

// Compile-time check that storage.EventStore satisfies EventReader for the
// handful of methods we actually use.
var _ EventReader = (storage.EventStore)(nil)
