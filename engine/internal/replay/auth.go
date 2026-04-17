package replay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
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

// AuthCallback asks a user-provided HTTP endpoint for a fresh credential per
// captured user id. The callback receives {event_id, user_id, path, method}
// and must return {header, value} JSON. Responses are cached per user_id for
// CacheTTL so we don't hit the callback on every event.
type AuthCallback struct {
	URL      string
	CacheTTL time.Duration

	mu    sync.Mutex
	cache map[string]authCacheEntry
}

type authCacheEntry struct {
	Header    string
	Value     string
	ExpiresAt time.Time
}

// Apply fetches credentials (using the cache) and sets the header.
func (a *AuthCallback) Apply(req *http.Request) error {
	if a.URL == "" {
		return errors.New("auth callback: URL is required")
	}
	userID := req.Header.Get("X-Clearvoiance-User-Id")
	eventID := req.Header.Get("X-Clearvoiance-Event-Id")
	cacheKey := userID

	a.mu.Lock()
	if a.cache == nil {
		a.cache = make(map[string]authCacheEntry)
	}
	if entry, ok := a.cache[cacheKey]; ok && time.Now().Before(entry.ExpiresAt) {
		a.mu.Unlock()
		req.Header.Set(entry.Header, entry.Value)
		return nil
	}
	a.mu.Unlock()

	payload := map[string]string{
		"event_id": eventID,
		"user_id":  userID,
		"method":   req.Method,
		"path":     req.URL.Path,
	}
	body, _ := json.Marshal(payload)
	cbCtx, cancel := context.WithTimeout(req.Context(), 5*time.Second)
	defer cancel()
	cbReq, err := http.NewRequestWithContext(cbCtx, http.MethodPost, a.URL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("auth callback: build request: %w", err)
	}
	cbReq.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(cbReq)
	if err != nil {
		return fmt.Errorf("auth callback: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("auth callback: non-200 %d: %s", resp.StatusCode, string(raw))
	}

	var out struct {
		Header string `json:"header"`
		Value  string `json:"value"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return fmt.Errorf("auth callback: decode response: %w", err)
	}
	if out.Header == "" {
		out.Header = "Authorization"
	}

	ttl := a.CacheTTL
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	a.mu.Lock()
	a.cache[cacheKey] = authCacheEntry{
		Header:    out.Header,
		Value:     out.Value,
		ExpiresAt: time.Now().Add(ttl),
	}
	a.mu.Unlock()

	req.Header.Set(out.Header, out.Value)
	return nil
}

// Name returns "callback".
func (*AuthCallback) Name() string { return "callback" }

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
			Header:      s.JwtResign.GetHeader(),
			Prefix:      s.JwtResign.GetPrefix(),
			SigningKey:  []byte(s.JwtResign.GetSigningKey()),
			FreshExpiry: time.Duration(s.JwtResign.GetFreshExpirySeconds()) * time.Second,
		}
	case *pb.AuthStrategy_Callback:
		return &AuthCallback{
			URL:      s.Callback.GetUrl(),
			CacheTTL: time.Duration(s.Callback.GetCacheTtlSeconds()) * time.Second,
		}
	}
	return AuthNone{}
}
