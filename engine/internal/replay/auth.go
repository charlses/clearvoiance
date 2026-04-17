package replay

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"

	pb "github.com/charlses/clearvoiance/engine/internal/pb/clearvoiance/v1"
)

// AuthStrategy rewrites credentials on a replayed request before it goes out.
// Strategies are stateless after construction; a single instance is shared
// across the worker pool.
type AuthStrategy interface {
	// Apply mutates the request headers. Return an error to abort the
	// dispatch for this event (dispatcher records it as an error row).
	Apply(req *http.Request) error
	Name() string
}

// AuthNone passes captured headers through unchanged.
type AuthNone struct{}

// Apply is a no-op.
func (AuthNone) Apply(_ *http.Request) error { return nil }

// Name returns "none".
func (AuthNone) Name() string { return "none" }

// AuthStaticSwap replaces a single header with a fixed prefix+token.
type AuthStaticSwap struct {
	Header string // defaults to "Authorization"
	Prefix string
	Token  string
}

// Apply sets the configured header.
func (a AuthStaticSwap) Apply(req *http.Request) error {
	header := a.Header
	if header == "" {
		header = "Authorization"
	}
	req.Header.Set(header, a.Prefix+a.Token)
	return nil
}

// Name returns "static_swap".
func (AuthStaticSwap) Name() string { return "static_swap" }

// AuthJWTResign parses the HS256 JWT from the configured header, rewrites the
// exp + iat claims to now, and re-signs with the configured key. Other claims
// pass through untouched so `sub`/`role`/etc. are preserved.
type AuthJWTResign struct {
	Header       string        // defaults to "Authorization"
	Prefix       string        // e.g. "Bearer "
	SigningKey   []byte        // HMAC secret
	FreshExpiry  time.Duration // defaults to 1h when zero
}

// Apply rewrites the auth header with a freshly-signed JWT.
func (a AuthJWTResign) Apply(req *http.Request) error {
	header := a.Header
	if header == "" {
		header = "Authorization"
	}
	raw := req.Header.Get(header)
	if raw == "" {
		// No token on this request — common for unauthenticated endpoints.
		// Skip silently; request goes out as-is.
		return nil
	}
	token := raw
	if a.Prefix != "" && strings.HasPrefix(raw, a.Prefix) {
		token = strings.TrimPrefix(raw, a.Prefix)
	}

	parsed, err := jwt.Parse(token,
		func(_ *jwt.Token) (interface{}, error) { return a.SigningKey, nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		// Don't check expiration on the INPUT — captured tokens will be expired.
		jwt.WithExpirationRequired(),
		jwt.WithoutClaimsValidation(),
	)
	if err != nil {
		return fmt.Errorf("parse jwt: %w", err)
	}
	claims, ok := parsed.Claims.(jwt.MapClaims)
	if !ok {
		return errors.New("unexpected jwt claims shape")
	}

	freshExpiry := a.FreshExpiry
	if freshExpiry == 0 {
		freshExpiry = time.Hour
	}
	now := time.Now()
	claims["iat"] = now.Unix()
	claims["exp"] = now.Add(freshExpiry).Unix()

	newToken := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := newToken.SignedString(a.SigningKey)
	if err != nil {
		return fmt.Errorf("sign jwt: %w", err)
	}
	req.Header.Set(header, a.Prefix+signed)
	return nil
}

// Name returns "jwt_resign".
func (AuthJWTResign) Name() string { return "jwt_resign" }

// AuthFromProto builds an AuthStrategy from the wire message. Unset / None
// both return AuthNone so callers always get a usable value.
func AuthFromProto(msg *pb.AuthStrategy) AuthStrategy {
	if msg == nil {
		return AuthNone{}
	}
	switch s := msg.GetStrategy().(type) {
	case *pb.AuthStrategy_None:
		return AuthNone{}
	case *pb.AuthStrategy_StaticSwap:
		return AuthStaticSwap{
			Header: s.StaticSwap.GetHeader(),
			Prefix: s.StaticSwap.GetPrefix(),
			Token:  s.StaticSwap.GetToken(),
		}
	case *pb.AuthStrategy_JwtResign:
		return AuthJWTResign{
			Header:     s.JwtResign.GetHeader(),
			Prefix:     s.JwtResign.GetPrefix(),
			SigningKey: []byte(s.JwtResign.GetSigningKey()),
			FreshExpiry: time.Duration(s.JwtResign.GetFreshExpirySeconds()) * time.Second,
		}
	}
	return AuthNone{}
}
