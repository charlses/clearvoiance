package rest

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
	chstore "github.com/charlses/clearvoiance/engine/internal/storage/clickhouse"
)

// Runtime-samples endpoints expose the SDK's instrumentRuntime() output.
// Samples are process-scoped; the /replays/{id}/runtime endpoint joins
// them to a replay's time window + source session so the UI can show
// memory / CPU / event-loop / pool state ACROSS the replay.

type runtimePoint struct {
	SampledAt      time.Time `json:"sampled_at"`
	MemRss         int64     `json:"mem_rss"`
	MemHeapUsed    int64     `json:"mem_heap_used"`
	MemHeapTotal   int64     `json:"mem_heap_total"`
	EventLoopP50Ns int64     `json:"event_loop_p50_ns"`
	EventLoopP99Ns int64     `json:"event_loop_p99_ns"`
	EventLoopMaxNs int64     `json:"event_loop_max_ns"`
	GcCount        int32     `json:"gc_count"`
	GcTotalPauseNs int64     `json:"gc_total_pause_ns"`
	CpuUserUs      int64     `json:"cpu_user_us"`
	CpuSystemUs    int64     `json:"cpu_system_us"`
	ActiveHandles  int32     `json:"active_handles"`
	ActiveRequests int32     `json:"active_requests"`
	DbPoolUsed     int32     `json:"db_pool_used"`
	DbPoolFree     int32     `json:"db_pool_free"`
	DbPoolPending  int32     `json:"db_pool_pending"`
	DbPoolMax      int32     `json:"db_pool_max"`
}

type runtimeSummary struct {
	Samples            int     `json:"samples"`
	WindowStartNs      int64   `json:"window_start_ns"`
	WindowEndNs        int64   `json:"window_end_ns"`
	MemRssPeak         int64   `json:"mem_rss_peak"`
	MemRssMin          int64   `json:"mem_rss_min"`
	EventLoopP99PeakMs float64 `json:"event_loop_p99_peak_ms"`
	PoolSaturatedSec   float64 `json:"pool_saturated_sec"`
	PoolMax            int32   `json:"pool_max"`
	GcTotalPauseMs     float64 `json:"gc_total_pause_ms"`
}

func mountRuntime(r chi.Router, d Deps) {
	h := &runtimeHandler{dsn: d.ClickhouseDSN, meta: d.MetaStore}
	r.Route("/replays/{id}/runtime", func(r chi.Router) {
		r.Get("/", h.samples)
		r.Get("/summary", h.summary)
	})
}

type runtimeHandler struct {
	dsn  string
	meta metadata.Store
}

// samples returns every runtime sample captured during the replay's window.
func (h *runtimeHandler) samples(w http.ResponseWriter, r *http.Request) {
	if h.dsn == "" {
		WriteError(w, http.StatusServiceUnavailable, "RUNTIME_UNAVAILABLE",
			"engine has no ClickHouse DSN configured", nil)
		return
	}
	id := chi.URLParam(r, "id")

	row, err := h.meta.Replays().Get(r.Context(), id)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL", "metadata: "+err.Error(), nil)
		return
	}
	if row == nil {
		WriteError(w, http.StatusNotFound, "NOT_FOUND", "replay not found", nil)
		return
	}
	startNs := row.StartedAt.UnixNano()
	var endNs int64
	if row.FinishedAt != nil {
		endNs = row.FinishedAt.UnixNano()
	} else {
		endNs = time.Now().UnixNano()
	}

	conn, err := openCH(r.Context(), h.dsn)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL", err.Error(), nil)
		return
	}
	defer conn.Close()
	if err := conn.Exec(r.Context(), chstore.RuntimeSamplesSchema); err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"ensure table: "+err.Error(), nil)
		return
	}

	rows, err := conn.Query(r.Context(), `
		SELECT
		  fromUnixTimestamp64Nano(sampled_at_ns) AS sampled_at,
		  mem_rss, mem_heap_used, mem_heap_total,
		  event_loop_p50_ns, event_loop_p99_ns, event_loop_max_ns,
		  gc_count, gc_total_pause_ns,
		  cpu_user_us, cpu_system_us,
		  active_handles, active_requests,
		  db_pool_used, db_pool_free, db_pool_pending, db_pool_max
		FROM runtime_samples
		WHERE session_id = ?
		  AND sampled_at_ns BETWEEN ? AND ?
		ORDER BY sampled_at_ns
	`, row.SourceSessionID, startNs, endNs)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"query: "+err.Error(), nil)
		return
	}
	defer rows.Close()

	out := []runtimePoint{}
	for rows.Next() {
		var p runtimePoint
		if err := rows.Scan(
			&p.SampledAt, &p.MemRss, &p.MemHeapUsed, &p.MemHeapTotal,
			&p.EventLoopP50Ns, &p.EventLoopP99Ns, &p.EventLoopMaxNs,
			&p.GcCount, &p.GcTotalPauseNs,
			&p.CpuUserUs, &p.CpuSystemUs,
			&p.ActiveHandles, &p.ActiveRequests,
			&p.DbPoolUsed, &p.DbPoolFree, &p.DbPoolPending, &p.DbPoolMax,
		); err != nil {
			WriteError(w, http.StatusInternalServerError, "INTERNAL", "scan: "+err.Error(), nil)
			return
		}
		out = append(out, p)
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"replay_id": id,
		"points":    out,
	})
}

// summary returns peak + aggregate stats for the replay window.
func (h *runtimeHandler) summary(w http.ResponseWriter, r *http.Request) {
	if h.dsn == "" {
		WriteError(w, http.StatusServiceUnavailable, "RUNTIME_UNAVAILABLE",
			"engine has no ClickHouse DSN configured", nil)
		return
	}
	id := chi.URLParam(r, "id")

	row, err := h.meta.Replays().Get(r.Context(), id)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL", "metadata: "+err.Error(), nil)
		return
	}
	if row == nil {
		WriteError(w, http.StatusNotFound, "NOT_FOUND", "replay not found", nil)
		return
	}
	startNs := row.StartedAt.UnixNano()
	var endNs int64
	if row.FinishedAt != nil {
		endNs = row.FinishedAt.UnixNano()
	} else {
		endNs = time.Now().UnixNano()
	}

	conn, err := openCH(r.Context(), h.dsn)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL", err.Error(), nil)
		return
	}
	defer conn.Close()
	if err := conn.Exec(r.Context(), chstore.RuntimeSamplesSchema); err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"ensure table: "+err.Error(), nil)
		return
	}

	ch := conn.QueryRow(r.Context(), `
		SELECT
		  count()                                                            AS samples,
		  ifNull(min(sampled_at_ns), 0)                                      AS window_start_ns,
		  ifNull(max(sampled_at_ns), 0)                                      AS window_end_ns,
		  ifNull(max(mem_rss), 0)                                            AS mem_rss_peak,
		  ifNull(min(mem_rss), 0)                                            AS mem_rss_min,
		  round(ifNull(max(event_loop_p99_ns), 0) / 1e6, 2)                  AS event_loop_p99_peak_ms,
		  countIf(db_pool_used >= db_pool_max AND db_pool_pending > 0) * 1.0 AS pool_saturated_sec,
		  ifNull(max(db_pool_max), 0)                                        AS pool_max,
		  round(ifNull(sum(gc_total_pause_ns), 0) / 1e6, 2)                  AS gc_total_pause_ms
		FROM runtime_samples
		WHERE session_id = ?
		  AND sampled_at_ns BETWEEN ? AND ?
	`, row.SourceSessionID, startNs, endNs)

	var s runtimeSummary
	if err := ch.Scan(
		&s.Samples, &s.WindowStartNs, &s.WindowEndNs,
		&s.MemRssPeak, &s.MemRssMin, &s.EventLoopP99PeakMs,
		&s.PoolSaturatedSec, &s.PoolMax, &s.GcTotalPauseMs,
	); err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL", "scan: "+err.Error(), nil)
		return
	}
	WriteJSON(w, http.StatusOK, s)
}

