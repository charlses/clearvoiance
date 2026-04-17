// Package rest implements the engine's HTTP/JSON control-plane API.
// See plan/15-phase-5-control-plane.md for the full surface.
package rest

import (
	"encoding/json"
	"net/http"
)

// APIError is the wire shape of every 4xx/5xx response. The `code` field is
// a stable string ("SESSION_NOT_FOUND", "UNAUTHENTICATED", etc.) that
// clients can switch on without parsing the message.
type APIError struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

// ErrorEnvelope wraps an APIError in `{"error": {...}}` per the plan.
type ErrorEnvelope struct {
	Error APIError `json:"error"`
}

// WriteError renders an error response.
func WriteError(w http.ResponseWriter, status int, code, msg string, details map[string]any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(ErrorEnvelope{
		Error: APIError{Code: code, Message: msg, Details: details},
	})
}

// WriteJSON renders a 2xx response with JSON body.
func WriteJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// ReadJSON decodes a JSON request body with a 1MB cap so malformed/huge
// bodies don't OOM us. Returns 400 on parse failure.
func ReadJSON(w http.ResponseWriter, r *http.Request, out any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(out); err != nil {
		WriteError(w, http.StatusBadRequest, "BAD_REQUEST",
			"could not decode request body: "+err.Error(), nil)
		return false
	}
	return true
}
