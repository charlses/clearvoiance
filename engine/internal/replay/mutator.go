package replay

import (
	"encoding/json"
	"fmt"
	"strings"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
)

// Mutator rewrites a captured HTTP request body before dispatch. vu is the
// virtual-user index (0 for the original, 1.. for fan-out replicas). Return
// an error to abort the dispatch.
type Mutator interface {
	Mutate(body []byte, contentType string, vu int) ([]byte, error)
	Name() string
}

// MutatorNone passes the body through unchanged.
type MutatorNone struct{}

// Mutate returns body unchanged.
func (MutatorNone) Mutate(body []byte, _ string, _ int) ([]byte, error) { return body, nil }

// Name returns "none".
func (MutatorNone) Name() string { return "none" }

// MutatorUniqueFields rewrites JSON body fields so each virtual user gets
// unique values for specified paths. Supports a simple subset of JSONPath:
//
//	$.field                     (top-level key)
//	$.parent.child              (nested keys)
//
// Strings with "@" (emails) get "+vuN" inserted before the "@". Other strings
// get "-vuN" appended. Integers get vu*IntMultiplier added.
type MutatorUniqueFields struct {
	Paths         []string
	IntMultiplier int64
}

// Mutate applies the per-VU transform. vu=0 leaves the body alone so the
// original dispatch matches the captured behaviour.
func (m MutatorUniqueFields) Mutate(body []byte, contentType string, vu int) ([]byte, error) {
	if vu == 0 || len(body) == 0 || len(m.Paths) == 0 {
		return body, nil
	}
	if !isJSON(contentType) {
		return body, nil
	}
	mul := m.IntMultiplier
	if mul == 0 {
		mul = 1_000_000
	}

	var doc any
	if err := json.Unmarshal(body, &doc); err != nil {
		// Not JSON — skip mutation, don't break replay.
		return body, nil
	}

	for _, path := range m.Paths {
		parts, ok := parseJSONPath(path)
		if !ok {
			continue
		}
		doc = mutateAtPath(doc, parts, func(value any) any {
			return mutateValue(value, vu, mul)
		})
	}

	out, err := json.Marshal(doc)
	if err != nil {
		return nil, fmt.Errorf("re-marshal mutated body: %w", err)
	}
	return out, nil
}

// Name returns "unique_fields".
func (MutatorUniqueFields) Name() string { return "unique_fields" }

// MutatorFromProto builds a Mutator from the wire message.
func MutatorFromProto(msg *pb.MutatorConfig) Mutator {
	if msg == nil {
		return MutatorNone{}
	}
	switch m := msg.GetMutator().(type) {
	case *pb.MutatorConfig_None:
		return MutatorNone{}
	case *pb.MutatorConfig_UniqueFields:
		return MutatorUniqueFields{
			Paths:         m.UniqueFields.GetJsonPaths(),
			IntMultiplier: m.UniqueFields.GetIntMultiplier(),
		}
	}
	return MutatorNone{}
}

// --- JSONPath helpers ----------------------------------------------------

func parseJSONPath(path string) ([]string, bool) {
	// Very simple subset: $.a.b.c -> ["a", "b", "c"]
	path = strings.TrimSpace(path)
	if !strings.HasPrefix(path, "$.") {
		return nil, false
	}
	rest := strings.TrimPrefix(path, "$.")
	if rest == "" {
		return nil, false
	}
	return strings.Split(rest, "."), true
}

// mutateAtPath walks `doc` down `parts`, calling `mutate` on the leaf value
// and replacing it with the return. Silently no-ops if the path doesn't match.
func mutateAtPath(doc any, parts []string, mutate func(any) any) any {
	obj, ok := doc.(map[string]any)
	if !ok {
		return doc
	}
	if len(parts) == 1 {
		if val, exists := obj[parts[0]]; exists {
			obj[parts[0]] = mutate(val)
		}
		return obj
	}
	if next, ok := obj[parts[0]]; ok {
		obj[parts[0]] = mutateAtPath(next, parts[1:], mutate)
	}
	return obj
}

func mutateValue(value any, vu int, intMul int64) any {
	switch v := value.(type) {
	case string:
		if at := strings.Index(v, "@"); at != -1 {
			return v[:at] + fmt.Sprintf("+vu%d", vu) + v[at:]
		}
		return v + fmt.Sprintf("-vu%d", vu)
	case float64: // JSON numbers decode to float64
		return v + float64(int64(vu)*intMul)
	}
	return value
}

func isJSON(contentType string) bool {
	ct := strings.ToLower(contentType)
	return strings.HasPrefix(ct, "application/json") ||
		strings.Contains(ct, "+json")
}
