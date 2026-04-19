package replay

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
)

// QueueDispatcher POSTs a captured queue event to the SUT's invocation
// endpoint, the same way CronDispatcher does. The SUT-side (hermetic) invoke
// server routes the payload to the handler registered for the queue name
// via registerCronHandler / the BullMQ capture adapter.
//
// For captured jobs that the SUT must replay synchronously (the common
// case for BullMQ/pgboss/celery), invoke-mode is correct: the engine
// guarantees ordering + timing, the SUT runs the handler, the result row
// records response status. Publishing to the actual queue is possible in
// principle but would require broker credentials and is deferred — it's
// the Phase 7 non-goal "queue replay order".
type QueueDispatcher struct {
	log    *slog.Logger
	client *http.Client
	// InvokePath is appended to the target base URL. The default path
	// matches the SDK's invoke-server route for queues. Crons use
	// /__clearvoiance/cron/invoke today; queues share the same route
	// because the server keys on `name` which is enough to route to the
	// registered handler regardless of origin.
	InvokePath string
}

// NewQueueDispatcher constructs the dispatcher with sensible defaults.
func NewQueueDispatcher(log *slog.Logger) *QueueDispatcher {
	return &QueueDispatcher{
		log: log,
		client: &http.Client{
			Timeout: 60 * time.Second,
		},
		InvokePath: "/__clearvoiance/cron/invoke",
	}
}

// Name implements Dispatcher.
func (*QueueDispatcher) Name() string { return "queue" }

// CanHandle implements Dispatcher.
func (*QueueDispatcher) CanHandle(ev *pb.Event) bool {
	_, ok := ev.GetPayload().(*pb.Event_Queue)
	return ok
}

// Dispatch posts a payload derived from the captured QueueEvent to the
// SUT's invoke endpoint. Errors are never fatal to the replay run; they
// land in the DispatchResult so operators can see them in the results UI.
func (d *QueueDispatcher) Dispatch(ctx context.Context, ev *pb.Event, target *TargetConfig, vu int) (DispatchResult, error) {
	queue := ev.GetQueue()
	if queue == nil {
		return DispatchResult{}, fmt.Errorf("queue dispatcher: event has no queue payload")
	}

	base := strings.TrimRight(target.BaseURL, "/")
	url := base + d.InvokePath

	argsBytes, _ := fetchBody(ctx, queue.GetPayload(), target.BlobReader)

	// The handler registry uses `job_name` for queue events (that's what
	// the BullMQ adapter stashes in queue.Headers[job_name]). Fall back to
	// the queue name if no job name is present so the SUT still gets
	// something routable.
	name := queue.GetHeaders()["job_name"]
	if name == "" {
		name = queue.GetQueueName()
	}

	payload := map[string]any{
		"name":           name,
		"queue":          queue.GetQueueName(),
		"broker":         queue.GetBroker(),
		"message_id":     queue.GetMessageId(),
		"retry_count":    queue.GetRetryCount(),
		"vu":             vu,
		"args_base64":    encodeBase64(argsBytes),
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return DispatchResult{}, fmt.Errorf("marshal queue payload: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return DispatchResult{}, fmt.Errorf("build queue invoke request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "clearvoiance-replayer/0.1")
	req.Header.Set("X-Clearvoiance-Event-Id", ev.GetId())

	if target.Auth != nil {
		if err := target.Auth.Apply(req); err != nil {
			return DispatchResult{ErrorCode: "auth", ErrorMessage: err.Error()}, nil
		}
	}

	start := time.Now()
	resp, err := d.client.Do(req)
	if err != nil {
		return DispatchResult{
			ResponseDurationNs: time.Since(start).Nanoseconds(),
			ErrorCode:          "network",
			ErrorMessage:       err.Error(),
			BytesSent:          uint32(len(body)),
		}, nil
	}
	defer resp.Body.Close()

	return DispatchResult{
		ResponseStatus:     uint16(resp.StatusCode),
		ResponseDurationNs: time.Since(start).Nanoseconds(),
		BytesSent:          uint32(len(body)),
		HTTPMethod:         "POST",
		HTTPPath:           d.InvokePath,
		HTTPRoute:          d.InvokePath,
	}, nil
}
