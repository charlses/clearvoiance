// Package hermetic provides the engine-side machinery for hermetic-mode
// replay. See plan/13-phase-3-hermetic-mode.md for the full design.
package hermetic

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
)

// SignatureOf computes the canonical outbound signature used by the SDK's
// hermetic intercept to look up mocks. The SDK computes it on the live call
// at replay time; the engine computes it on the captured call at mock-pack
// export time so the two match.
//
// Semantics (must match sdk-node/src/outbound/signature.ts):
//
//	sha256(METHOD | host | path | body_hash)
//
// body_hash is:
//  1. "" when body is empty
//  2. sha256(body) when Content-Type is not JSON
//  3. sha256(canonical(body)) when Content-Type is JSON, where canonical()
//     parses + re-serializes with sorted keys (JSON-null-safe, HTML-escape off)
//
// This MVP uses default canonicalization (no ignore lists). Callers that need
// volatile-field stripping should pass it to the SDK side at hermetic init;
// the engine side tolerates it by re-hashing the same body identically.
func SignatureOf(method, host, path string, body []byte, contentType string) string {
	parts := []string{
		strings.ToUpper(method),
		strings.ToLower(host),
		path,
		bodyHash(body, contentType),
	}
	sum := sha256.Sum256([]byte(strings.Join(parts, "|")))
	return hex.EncodeToString(sum[:])
}

func bodyHash(body []byte, contentType string) string {
	if len(body) == 0 {
		return ""
	}
	if !strings.Contains(strings.ToLower(contentType), "json") {
		return sha256Hex(body)
	}
	// JSON path: parse, re-serialize with Go's encoding/json (which sorts
	// map keys alphabetically), hash the result. If parsing fails, fall
	// back to the raw-body hash so a signature still exists.
	var parsed any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return sha256Hex(body)
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false) // match JS JSON.stringify's non-escaping default
	if err := enc.Encode(parsed); err != nil {
		return sha256Hex(body)
	}
	// encoder appends a trailing newline; trim so we match a bare sha256(str).
	return sha256Hex(bytes.TrimRight(buf.Bytes(), "\n"))
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
