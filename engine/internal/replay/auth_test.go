package replay

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/require"
)

func newReq(t *testing.T, header, value string) *http.Request {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "http://example/x", nil)
	if header != "" {
		r.Header.Set(header, value)
	}
	return r
}

func TestAuthNone_PassThrough(t *testing.T) {
	r := newReq(t, "Authorization", "Bearer original")
	require.NoError(t, AuthNone{}.Apply(r))
	require.Equal(t, "Bearer original", r.Header.Get("Authorization"))
}

func TestAuthStaticSwap_OverwritesAuthorization(t *testing.T) {
	r := newReq(t, "Authorization", "Bearer original")
	a := AuthStaticSwap{Prefix: "Bearer ", Token: "new-token"}
	require.NoError(t, a.Apply(r))
	require.Equal(t, "Bearer new-token", r.Header.Get("Authorization"))
}

func TestAuthStaticSwap_CustomHeader(t *testing.T) {
	r := newReq(t, "", "")
	a := AuthStaticSwap{Header: "X-Api-Key", Token: "abc"}
	require.NoError(t, a.Apply(r))
	require.Equal(t, "abc", r.Header.Get("X-Api-Key"))
}

func TestAuthJWTResign_RefreshesExpAndKeepsClaims(t *testing.T) {
	secret := []byte("staging-signing-key")
	// Build an "expired" token — our resign must accept and refresh it.
	expired := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub":  "u-42",
		"role": "admin",
		"iat":  time.Now().Add(-2 * time.Hour).Unix(),
		"exp":  time.Now().Add(-1 * time.Hour).Unix(),
	})
	original, err := expired.SignedString(secret)
	require.NoError(t, err)

	r := newReq(t, "Authorization", "Bearer "+original)
	a := AuthJWTResign{Prefix: "Bearer ", SigningKey: secret, FreshExpiry: time.Hour}
	require.NoError(t, a.Apply(r))

	got := r.Header.Get("Authorization")
	require.True(t, strings.HasPrefix(got, "Bearer "))
	newTok := strings.TrimPrefix(got, "Bearer ")
	require.NotEqual(t, original, newTok)

	parsed, err := jwt.Parse(newTok,
		func(_ *jwt.Token) (interface{}, error) { return secret, nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
	)
	require.NoError(t, err)
	require.True(t, parsed.Valid)
	claims := parsed.Claims.(jwt.MapClaims)
	require.Equal(t, "u-42", claims["sub"])
	require.Equal(t, "admin", claims["role"])
	// exp must now be in the future.
	expVal, _ := claims["exp"].(float64)
	require.Greater(t, int64(expVal), time.Now().Unix())
}

func TestAuthJWTResign_NoHeaderIsNoOp(t *testing.T) {
	r := newReq(t, "", "")
	a := AuthJWTResign{SigningKey: []byte("k")}
	require.NoError(t, a.Apply(r))
	require.Equal(t, "", r.Header.Get("Authorization"))
}

func TestAuthJWTResign_InvalidTokenErrors(t *testing.T) {
	r := newReq(t, "Authorization", "Bearer not-a-jwt")
	a := AuthJWTResign{Prefix: "Bearer ", SigningKey: []byte("k")}
	require.Error(t, a.Apply(r))
}
