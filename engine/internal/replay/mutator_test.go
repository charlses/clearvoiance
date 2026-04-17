package replay

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestMutatorNone_Passthrough(t *testing.T) {
	body := []byte(`{"a":1}`)
	out, err := MutatorNone{}.Mutate(body, "application/json", 5)
	require.NoError(t, err)
	require.Equal(t, body, out)
}

func TestMutatorUniqueFields_EmailGetsPlusTag(t *testing.T) {
	m := MutatorUniqueFields{Paths: []string{"$.email"}}
	body := []byte(`{"email":"ada@example.com","name":"Ada"}`)

	// vu=0 is a no-op.
	out, err := m.Mutate(body, "application/json", 0)
	require.NoError(t, err)
	require.JSONEq(t, `{"email":"ada@example.com","name":"Ada"}`, string(out))

	out, err = m.Mutate(body, "application/json", 3)
	require.NoError(t, err)

	var doc map[string]any
	require.NoError(t, json.Unmarshal(out, &doc))
	require.Equal(t, "ada+vu3@example.com", doc["email"])
	require.Equal(t, "Ada", doc["name"])
}

func TestMutatorUniqueFields_StringGetsDashTag(t *testing.T) {
	m := MutatorUniqueFields{Paths: []string{"$.username"}}
	body := []byte(`{"username":"ada","age":30}`)
	out, err := m.Mutate(body, "application/json", 2)
	require.NoError(t, err)
	var doc map[string]any
	require.NoError(t, json.Unmarshal(out, &doc))
	require.Equal(t, "ada-vu2", doc["username"])
	require.Equal(t, float64(30), doc["age"])
}

func TestMutatorUniqueFields_IntGetsMultiplier(t *testing.T) {
	m := MutatorUniqueFields{Paths: []string{"$.account_id"}, IntMultiplier: 1000}
	body := []byte(`{"account_id":5}`)
	out, err := m.Mutate(body, "application/json", 4)
	require.NoError(t, err)
	var doc map[string]any
	require.NoError(t, json.Unmarshal(out, &doc))
	// 5 + 4*1000 = 4005
	require.Equal(t, float64(4005), doc["account_id"])
}

func TestMutatorUniqueFields_NestedPath(t *testing.T) {
	m := MutatorUniqueFields{Paths: []string{"$.user.email"}}
	body := []byte(`{"user":{"email":"grace@example.com","role":"admin"}}`)
	out, err := m.Mutate(body, "application/json", 1)
	require.NoError(t, err)
	var doc map[string]any
	require.NoError(t, json.Unmarshal(out, &doc))
	user := doc["user"].(map[string]any)
	require.Equal(t, "grace+vu1@example.com", user["email"])
	require.Equal(t, "admin", user["role"])
}

func TestMutatorUniqueFields_MissingPathIsNoOp(t *testing.T) {
	m := MutatorUniqueFields{Paths: []string{"$.does_not_exist"}}
	body := []byte(`{"email":"x@y"}`)
	out, err := m.Mutate(body, "application/json", 1)
	require.NoError(t, err)
	require.JSONEq(t, string(body), string(out))
}

func TestMutatorUniqueFields_NonJSONIsPassthrough(t *testing.T) {
	m := MutatorUniqueFields{Paths: []string{"$.email"}}
	body := []byte("plain text body")
	out, err := m.Mutate(body, "text/plain", 1)
	require.NoError(t, err)
	require.Equal(t, body, out)
}
