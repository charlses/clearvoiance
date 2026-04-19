package replay

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
)

// CronDispatcher POSTs a captured cron trigger to the SUT's invocation
// endpoint. The endpoint is the SDK's hermetic-mode "invoke server" from
// Phase 3 (@clearvoiance/node/hermetic/invoke-server), which runs at
// 127.0.0.1:7777 by default. Without that endpoint live the dispatch simply
// returns a connection error in the result row — expected for sessions
// replayed against a SUT that doesn't opt into hermetic mode.
type CronDispatcher struct {
	log    *slog.Logger
	client *http.Client
	// InvokePath is appended to the target base URL. Defaults to
	// "/__clearvoiance/cron/invoke".
	InvokePath string
}

// NewCronDispatcher constructs the dispatcher with sensible defaults.
func NewCronDispatcher(log *slog.Logger) *CronDispatcher {
	return &CronDispatcher{
		log: log,
		client: &http.Client{
			Timeout: 60 * time.Second,
		},
		InvokePath: "/__clearvoiance/cron/invoke",
	}
}

// Name implements Dispatcher.
func (*CronDispatcher) Name() string { return "cron" }

// CanHandle implements Dispatcher.
func (*CronDispatcher) CanHandle(ev *pb.Event) bool {
	_, ok := ev.GetPayload().(*pb.Event_Cron)
	return ok
}

// Dispatch posts { job_name, scheduler, trigger_source } to the SUT's invoke
// endpoint. The SUT's hermetic-mode cron killer looks up the registered
// handler by name and runs it.
func (d *CronDispatcher) Dispatch(ctx context.Context, ev *pb.Event, target *TargetConfig, vu int) (DispatchResult, error) {
	cron := ev.GetCron()
	if cron == nil {
		return DispatchResult{}, fmt.Errorf("cron dispatcher: event has no cron payload")
	}

	base := strings.TrimRight(target.BaseURL, "/")
	url := base + d.InvokePath

	// Keep args as opaque bytes; the SUT-side invoke server deserializes.
	argsBytes, _ := fetchBody(ctx, cron.GetArgs(), target.BlobReader)
	payload := map[string]any{
		"name":           cron.GetJobName(),
		"scheduler":      cron.GetScheduler(),
		"trigger_source": cron.GetTriggerSource(),
		"vu":             vu,
		"args_base64":    encodeBase64(argsBytes),
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return DispatchResult{}, fmt.Errorf("marshal cron payload: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return DispatchResult{}, fmt.Errorf("build cron invoke request: %w", err)
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

// encodeBase64 is the SDK-compatible encoder — the invoke-server on the
// SUT side decodes `args_base64` with base64. A previous version of this
// helper encoded hex (with a misleading comment claiming stdlib base64
// "would also work"). That was a latent bug: replayed cron/queue jobs ran
// with mangled args. Now we use the stdlib base64 directly; the hex branch
// is gone and the queue dispatcher shares this helper.
func encodeBase64(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	return base64.StdEncoding.EncodeToString(raw)
}
