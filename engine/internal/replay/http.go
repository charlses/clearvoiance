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
func (d *HTTPDispatcher) Dispatch(ctx context.Context, ev *pb.Event, target *TargetConfig, vu int) (DispatchResult, error) {
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

	bodyBytes, blobErr := fetchBody(ctx, httpEv.GetRequestBody(), target.BlobReader)
	if blobErr != nil {
		return DispatchResult{
			HTTPMethod:   httpEv.GetMethod(),
			HTTPPath:     path,
			HTTPRoute:    httpEv.GetRouteTemplate(),
			ErrorCode:    "blob_fetch",
			ErrorMessage: blobErr.Error(),
		}, nil
	}

	// Mutate per-VU (vu=0 leaves the body alone).
	if target.Mutator != nil {
		contentType := contentTypeFrom(httpEv)
		mutated, mErr := target.Mutator.Mutate(bodyBytes, contentType, vu)
		if mErr != nil {
			return DispatchResult{
				HTTPMethod: httpEv.GetMethod(),
				HTTPPath:   path,
				HTTPRoute:  httpEv.GetRouteTemplate(),
			}, fmt.Errorf("mutator: %w", mErr)
		}
		bodyBytes = mutated
	}

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
	if target.ReplayID != "" {
		req.Header.Set("X-Clearvoiance-Replay-Id", target.ReplayID)
	}
	if vu > 0 {
		req.Header.Set("X-Clearvoiance-Vu", fmt.Sprintf("%d", vu))
	}

	// Auth rewrite runs last so captured Authorization is available to parsers
	// (e.g. JWT resign reads the original then overwrites).
	if target.Auth != nil {
		if err := target.Auth.Apply(req); err != nil {
			return DispatchResult{
				HTTPMethod: httpEv.GetMethod(),
				HTTPPath:   path,
				HTTPRoute:  httpEv.GetRouteTemplate(),
			}, fmt.Errorf("auth: %w", err)
		}
	}

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

// contentTypeFrom reads Content-Type from a captured HTTP event's request body
// / headers. Falls back to "" so mutators can decide whether to act.
func contentTypeFrom(h *pb.HttpEvent) string {
	if h.GetRequestBody() != nil && h.GetRequestBody().GetContentType() != "" {
		return h.GetRequestBody().GetContentType()
	}
	if vals, ok := h.GetHeaders()["content-type"]; ok && len(vals.GetValues()) > 0 {
		return vals.GetValues()[0]
	}
	if vals, ok := h.GetHeaders()["Content-Type"]; ok && len(vals.GetValues()) > 0 {
		return vals.GetValues()[0]
	}
	return ""
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

// fetchBody returns the request body bytes for a captured Body, pulling from
// blob storage when the body is a BlobRef. Returns (nil, nil) for empty
// bodies. Returns (nil, err) when a BlobRef exists but no reader is wired up
// or the fetch fails — the caller turns this into a dispatcher result row.
func fetchBody(ctx context.Context, body *pb.Body, blobs interface {
	Get(context.Context, string, string) ([]byte, error)
}) ([]byte, error) {
	if body == nil {
		return nil, nil
	}
	if inline := body.GetInline(); len(inline) > 0 {
		return inline, nil
	}
	ref := body.GetBlob()
	if ref == nil {
		return nil, nil
	}
	if blobs == nil {
		return nil, fmt.Errorf("body stored as blob %s/%s but no blob reader configured",
			ref.GetBucket(), ref.GetKey())
	}
	return blobs.Get(ctx, ref.GetBucket(), ref.GetKey())
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
