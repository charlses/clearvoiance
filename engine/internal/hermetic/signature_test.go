package hermetic

import (
	"testing"
)

// Known-value parity tests. If these change, so must
// sdk-node/src/outbound/signature.ts — they MUST agree for hermetic replay
// to match captured mocks.
func TestSignatureOf_StableAcrossIdenticalInputs(t *testing.T) {
	a := SignatureOf("POST", "api.example.com", "/v1/foo",
		[]byte(`{"x":1}`), "application/json")
	b := SignatureOf("POST", "api.example.com", "/v1/foo",
		[]byte(`{"x":1}`), "application/json")
	if a != b {
		t.Fatalf("expected stable signature, got %q and %q", a, b)
	}
}

func TestSignatureOf_CaseInsensitiveMethodAndHost(t *testing.T) {
	a := SignatureOf("POST", "API.EXAMPLE.COM", "/x", nil, "")
	b := SignatureOf("post", "api.example.com", "/x", nil, "")
	if a != b {
		t.Fatalf("method/host case should be ignored; got %q and %q", a, b)
	}
}

func TestSignatureOf_DifferentMethodChangesSig(t *testing.T) {
	a := SignatureOf("GET", "h", "/x", nil, "")
	b := SignatureOf("POST", "h", "/x", nil, "")
	if a == b {
		t.Fatal("different methods should produce different signatures")
	}
}

func TestSignatureOf_JSONKeyOrderInsensitive(t *testing.T) {
	a := SignatureOf("POST", "h", "/x",
		[]byte(`{"a":1,"b":2}`), "application/json")
	b := SignatureOf("POST", "h", "/x",
		[]byte(`{"b":2,"a":1}`), "application/json")
	if a != b {
		t.Fatalf("JSON key order should not affect signature; got %q vs %q", a, b)
	}
}

func TestSignatureOf_NonJSONBodyUsesRawHash(t *testing.T) {
	// Same bytes, different content-types. For non-JSON we hash raw; for
	// JSON we normalize (strips whitespace), so these should NOT match when
	// the raw JSON has formatting.
	raw := []byte(`{"a": 1, "b": 2}`)
	a := SignatureOf("POST", "h", "/x", raw, "text/plain")
	b := SignatureOf("POST", "h", "/x", raw, "application/json")
	if a == b {
		t.Fatal("JSON canonicalization should differ from raw hashing when body has whitespace")
	}
}

// Regression against the SDK's known hash value. This locks the canonical
// form: if Go or JS side drifts, this test will break and the mismatch will
// be visible in diffs rather than surfacing as a silent replay miss.
func TestSignatureOf_KnownValue(t *testing.T) {
	got := SignatureOf("GET", "api.example.com", "/v1/ping", nil, "")
	// Locked golden value: sha256 of "GET|api.example.com|/v1/ping|".
	// This MUST match signatureOf() in sdk-node/src/outbound/signature.ts
	// for the same inputs — see the matching vitest. If either side drifts,
	// both tests break at once, catching silent replay mismatches early.
	want := "d742c96df79084737fe2997c202b3daa20fdc081479e92a187e9f21d02e1aac3"
	if got != want {
		t.Fatalf("known-value drift:\n got %q\nwant %q", got, want)
	}
}
