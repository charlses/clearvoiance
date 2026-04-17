package http

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	stdhttp "net/http"
	"net/http/httptest"
	"testing"
)

func TestHermeticUnmockedHandler_LogsValidRecord(t *testing.T) {
	// Capture logs via an in-memory handler so we can assert on them.
	var logged bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logged, &slog.HandlerOptions{Level: slog.LevelInfo}))

	srv := httptest.NewServer(HermeticUnmockedHandler(logger))
	t.Cleanup(srv.Close)

	rec := UnmockedRecord{
		SourceSessionID: "sess_abc",
		Protocol:        "https:",
		Method:          "POST",
		Host:            "api.example.com",
		Path:            "/v1/webhook",
		EventID:         "ev_1",
		Signature:       "deadbeef",
	}
	body, _ := json.Marshal(rec)

	req, err := stdhttp.NewRequestWithContext(context.Background(), "POST", srv.URL, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("content-type", "application/json")
	resp, err := stdhttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != stdhttp.StatusAccepted {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("want 202, got %d: %s", resp.StatusCode, b)
	}

	logs := logged.String()
	for _, want := range []string{"sess_abc", "api.example.com", "ev_1", "deadbeef", "unmocked outbound recorded"} {
		if !bytes.Contains(logged.Bytes(), []byte(want)) {
			t.Errorf("log did not contain %q\nfull logs:\n%s", want, logs)
		}
	}
}

func TestHermeticUnmockedHandler_RejectsMalformedBody(t *testing.T) {
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	srv := httptest.NewServer(HermeticUnmockedHandler(logger))
	t.Cleanup(srv.Close)

	resp, err := stdhttp.Post(srv.URL, "application/json", bytes.NewReader([]byte("{not json")))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != stdhttp.StatusBadRequest {
		t.Fatalf("want 400, got %d", resp.StatusCode)
	}
}

func TestHermeticUnmockedHandler_RejectsNonPost(t *testing.T) {
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	srv := httptest.NewServer(HermeticUnmockedHandler(logger))
	t.Cleanup(srv.Close)

	resp, err := stdhttp.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != stdhttp.StatusMethodNotAllowed {
		t.Fatalf("want 405, got %d", resp.StatusCode)
	}
}

func TestNewMux_ServesHealthz(t *testing.T) {
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	srv := httptest.NewServer(NewMux(logger))
	t.Cleanup(srv.Close)

	resp, err := stdhttp.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("healthz status: want 200, got %d", resp.StatusCode)
	}
}
