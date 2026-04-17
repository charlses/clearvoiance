package replay

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
)

// HTTPDispatcher fires captured HTTP events against a target base URL.
// Phase 2a scope: inline request bodies only; BlobRef bodies become empty
// bodies on the wire (Phase 2b will fetch them from MinIO).
type HTTPDispatcher struct {
	client *http.Client
}

// NewHTTPDispatcher constructs a dispatcher backed by net/http with
// production-friendly defaults (keep-alives, bounded timeout).
func NewHTTPDispatcher() *HTTPDispatcher {
	transport := &http.Transport{
		MaxIdleConns:        0, // unlimited
		MaxIdleConnsPerHost: 1000,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  true, // we're replaying opaque bodies
	}
	return &HTTPDispatcher{
		client: &http.Client{
			Transport: transport,
			Timeout:   30 * time.Second,
			// Don't follow redirects — replaying should observe them as-is.
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

// Name implements Dispatcher.
func (*HTTPDispatcher) Name() string { return "http" }

// CanHandle implements Dispatcher. Accepts inbound HTTP + webhook events.
func (*HTTPDispatcher) CanHandle(ev *pb.Event) bool {
	switch ev.GetPayload().(type) {
	case *pb.Event_Http, *pb.Event_Webhook:
		return true
	}
	return false
}

// Dispatch implements Dispatcher.
func (d *HTTPDispatcher) Dispatch(ctx context.Context, ev *pb.Event, target *TargetConfig) (DispatchResult, error) {
	httpEv := extractHTTP(ev)
	if httpEv == nil {
		return DispatchResult{}, fmt.Errorf("http dispatcher: event has no http payload")
	}

	base := strings.TrimRight(target.BaseURL, "/")
	path := httpEv.GetPath()
	if path == "" {
		path = "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	fullURL := base + path

	bodyBytes := extractBody(httpEv.GetRequestBody())
	req, err := http.NewRequestWithContext(ctx, httpEv.GetMethod(), fullURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return DispatchResult{
			HTTPMethod: httpEv.GetMethod(),
			HTTPPath:   path,
			HTTPRoute:  httpEv.GetRouteTemplate(),
		}, fmt.Errorf("build request: %w", err)
	}

	// Replay the original headers (skip hop-by-hop + ones the SDK redacted).
	for name, values := range httpEv.GetHeaders() {
		if shouldSkipHeader(name) {
			continue
		}
		for _, v := range values.GetValues() {
			if v == "[REDACTED]" {
				continue
			}
			req.Header.Add(name, v)
		}
	}
	// Mark these requests so a sharp-eyed operator can tell them apart from
	// real traffic on the target.
	req.Header.Set("User-Agent", "clearvoiance-replayer/0.1")
	req.Header.Set("X-Clearvoiance-Event-Id", ev.GetId())

	start := time.Now()
	resp, err := d.client.Do(req)
	if err != nil {
		return DispatchResult{
			ResponseDurationNs: time.Since(start).Nanoseconds(),
			ErrorCode:          "network",
			ErrorMessage:       err.Error(),
			BytesSent:          uint32(len(bodyBytes)),
			HTTPMethod:         httpEv.GetMethod(),
			HTTPPath:           path,
			HTTPRoute:          httpEv.GetRouteTemplate(),
		}, nil // not a dispatcher-level error; the result captures it
	}
	defer resp.Body.Close()

	// Read + discard the response so the connection can be reused; track size.
	nRead, _ := io.Copy(io.Discard, resp.Body)
	duration := time.Since(start)

	return DispatchResult{
		ResponseStatus:     uint16(resp.StatusCode),
		ResponseDurationNs: duration.Nanoseconds(),
		BytesSent:          uint32(len(bodyBytes)),
		BytesReceived:      uint32(nRead),
		HTTPMethod:         httpEv.GetMethod(),
		HTTPPath:           path,
		HTTPRoute:          httpEv.GetRouteTemplate(),
	}, nil
}

func extractHTTP(ev *pb.Event) *pb.HttpEvent {
	switch p := ev.GetPayload().(type) {
	case *pb.Event_Http:
		return p.Http
	case *pb.Event_Webhook:
		return p.Webhook.GetHttp()
	}
	return nil
}

func extractBody(body *pb.Body) []byte {
	if body == nil {
		return nil
	}
	// Phase 2a: inline only. BlobRef bodies come back from MinIO in 2b.
	return body.GetInline()
}

// shouldSkipHeader drops hop-by-hop + replay-toxic headers.
func shouldSkipHeader(name string) bool {
	switch strings.ToLower(name) {
	case "host",
		"content-length",
		"connection",
		"keep-alive",
		"proxy-authenticate",
		"proxy-authorization",
		"te",
		"trailer",
		"transfer-encoding",
		"upgrade",
		"accept-encoding": // we disabled compression on the client
		return true
	}
	return false
}
