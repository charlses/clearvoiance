// Package telemetry provides structured logging, metrics, and tracing for the engine.
//
// Phase 0 scope: slog-based logger only. Metrics (Prometheus) and traces (OpenTelemetry)
// land in later phases — see plan/02-tech-stack.md.
package telemetry

import (
	"log/slog"
	"os"
	"strings"
)

// NewLogger returns a JSON structured logger reading level from CLEARVOIANCE_LOG_LEVEL.
// Valid levels: debug, info, warn, error. Default: info.
func NewLogger() *slog.Logger {
	level := parseLevel(os.Getenv("CLEARVOIANCE_LOG_LEVEL"))

	handler := slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{
		Level: level,
	})

	return slog.New(handler)
}

func parseLevel(raw string) slog.Level {
	switch strings.ToLower(raw) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
