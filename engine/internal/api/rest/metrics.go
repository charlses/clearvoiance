package rest

import (
	"fmt"
	"net/http"
	"runtime"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
)

// MetricsRegistry holds the counters we expose on GET /metrics. The engine
// creates one instance in serve.go and hands it to every subsystem that
// wants to increment a counter (request handler, replay scheduler, etc.).
// Kept deliberately small; a full Prometheus client is heavy and this
// endpoint is for operator eyeballing + scraping.
type MetricsRegistry struct {
	start time.Time

	HTTPRequestsTotal     atomic.Int64
	HTTPRequests4xxTotal  atomic.Int64
	HTTPRequests5xxTotal  atomic.Int64
	SessionsStartedTotal  atomic.Int64
	SessionsStoppedTotal  atomic.Int64
	ReplaysStartedTotal   atomic.Int64
	ReplaysCompletedTotal atomic.Int64
	EventsIngestedTotal   atomic.Int64
}

// NewMetricsRegistry captures the process start time so the uptime gauge
// has something to anchor against.
func NewMetricsRegistry() *MetricsRegistry {
	return &MetricsRegistry{start: time.Now()}
}

func mountMetrics(r chi.Router, reg *MetricsRegistry) {
	if reg == nil {
		reg = NewMetricsRegistry()
	}
	r.Get("/metrics", func(w http.ResponseWriter, _ *http.Request) {
		var mem runtime.MemStats
		runtime.ReadMemStats(&mem)
		uptime := time.Since(reg.start).Seconds()

		// Prometheus text exposition format. Plain text; the standard
		// scraper tolerates ordering + trailing whitespace.
		w.Header().Set("content-type", "text/plain; version=0.0.4")
		fmt.Fprintln(w, "# HELP clv_engine_uptime_seconds Seconds since the engine process started")
		fmt.Fprintln(w, "# TYPE clv_engine_uptime_seconds gauge")
		fmt.Fprintf(w, "clv_engine_uptime_seconds %.3f\n", uptime)

		fmt.Fprintln(w, "# HELP clv_engine_goroutines Current goroutine count")
		fmt.Fprintln(w, "# TYPE clv_engine_goroutines gauge")
		fmt.Fprintf(w, "clv_engine_goroutines %d\n", runtime.NumGoroutine())

		fmt.Fprintln(w, "# HELP clv_engine_memory_alloc_bytes Currently allocated heap bytes")
		fmt.Fprintln(w, "# TYPE clv_engine_memory_alloc_bytes gauge")
		fmt.Fprintf(w, "clv_engine_memory_alloc_bytes %d\n", mem.Alloc)

		fmt.Fprintln(w, "# HELP clv_http_requests_total Total REST API requests served")
		fmt.Fprintln(w, "# TYPE clv_http_requests_total counter")
		fmt.Fprintf(w, "clv_http_requests_total %d\n", reg.HTTPRequestsTotal.Load())

		fmt.Fprintln(w, "# HELP clv_http_requests_4xx_total Total 4xx responses")
		fmt.Fprintln(w, "# TYPE clv_http_requests_4xx_total counter")
		fmt.Fprintf(w, "clv_http_requests_4xx_total %d\n", reg.HTTPRequests4xxTotal.Load())

		fmt.Fprintln(w, "# HELP clv_http_requests_5xx_total Total 5xx responses")
		fmt.Fprintln(w, "# TYPE clv_http_requests_5xx_total counter")
		fmt.Fprintf(w, "clv_http_requests_5xx_total %d\n", reg.HTTPRequests5xxTotal.Load())

		fmt.Fprintln(w, "# HELP clv_sessions_started_total Sessions opened via REST or gRPC")
		fmt.Fprintln(w, "# TYPE clv_sessions_started_total counter")
		fmt.Fprintf(w, "clv_sessions_started_total %d\n", reg.SessionsStartedTotal.Load())

		fmt.Fprintln(w, "# HELP clv_sessions_stopped_total Sessions closed (manual or sweeper)")
		fmt.Fprintln(w, "# TYPE clv_sessions_stopped_total counter")
		fmt.Fprintf(w, "clv_sessions_stopped_total %d\n", reg.SessionsStoppedTotal.Load())

		fmt.Fprintln(w, "# HELP clv_replays_started_total Replays started")
		fmt.Fprintln(w, "# TYPE clv_replays_started_total counter")
		fmt.Fprintf(w, "clv_replays_started_total %d\n", reg.ReplaysStartedTotal.Load())

		fmt.Fprintln(w, "# HELP clv_replays_completed_total Replays that reached completed/failed/cancelled")
		fmt.Fprintln(w, "# TYPE clv_replays_completed_total counter")
		fmt.Fprintf(w, "clv_replays_completed_total %d\n", reg.ReplaysCompletedTotal.Load())

		fmt.Fprintln(w, "# HELP clv_events_ingested_total Events acked through StreamEvents")
		fmt.Fprintln(w, "# TYPE clv_events_ingested_total counter")
		fmt.Fprintf(w, "clv_events_ingested_total %d\n", reg.EventsIngestedTotal.Load())
	})
}

// MetricsMiddleware observes the HTTP request count + status-class split.
// Mount after the RequestID / RealIP middlewares but before AuthMiddleware
// so unauthenticated 401s still count toward request totals.
func MetricsMiddleware(reg *MetricsRegistry) func(http.Handler) http.Handler {
	if reg == nil {
		return func(next http.Handler) http.Handler { return next }
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rw := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rw, r)
			reg.HTTPRequestsTotal.Add(1)
			switch {
			case rw.status >= 500:
				reg.HTTPRequests5xxTotal.Add(1)
			case rw.status >= 400:
				reg.HTTPRequests4xxTotal.Add(1)
			}
		})
	}
}
