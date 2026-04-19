// Dashboard login + setup endpoints. Mounted under /api/v1/auth/*.
//
// Routes:
//   POST /auth/setup           — first-run: creates the sole admin when
//                                users is empty. Refuses otherwise.
//   POST /auth/login           — email + password → Set-Cookie session.
//   POST /auth/logout          — invalidates the current session.
//   GET  /auth/me              — returns the current user (needs session).
//   POST /auth/change-password — self-serve password rotation (needs
//                                session). Revokes all other sessions.
//   GET  /auth/state           — unauthenticated: "is setup needed?".
//                                Lets the dashboard decide whether to
//                                show /setup or /login without trying
//                                an auth'd request first.

package rest

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

// authDeps is the narrow slice of Deps the auth handlers need. Pulled out
// so router wiring can be explicit about what gets injected.
type authDeps struct {
	users    metadata.Users
	sessions metadata.UserSessions
	cookie   CookieConfig
	argon2   Argon2idParams
}

// mountAuth attaches the /auth/* subtree. Called from Router().
func mountAuth(r chi.Router, deps authDeps) {
	r.Route("/auth", func(r chi.Router) {
		// Public (no auth) — bootstrap + login + state probe.
		r.Get("/state", deps.handleState)
		r.Post("/setup", deps.handleSetup)
		r.Post("/login", deps.handleLogin)

		// Logout works even if the cookie is stale — we just clear the
		// client-side cookie regardless of backend state.
		r.Post("/logout", deps.handleLogout)

		// Session-required paths.
		r.Group(func(r chi.Router) {
			r.Use(RequireUser)
			r.Get("/me", deps.handleMe)
			r.Post("/change-password", deps.handleChangePassword)
		})
	})
}

// --- /auth/state -------------------------------------------------------

type stateResponse struct {
	// SetupRequired is true iff zero users exist. Dashboard uses this to
	// route first-time visitors to /setup instead of /login.
	SetupRequired bool `json:"setup_required"`
}

func (d authDeps) handleState(w http.ResponseWriter, r *http.Request) {
	count, err := d.users.Count(r.Context())
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"count users: "+err.Error(), nil)
		return
	}
	WriteJSON(w, http.StatusOK, stateResponse{SetupRequired: count == 0})
}

// --- /auth/setup -------------------------------------------------------

type setupRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type setupResponse struct {
	User userResponse `json:"user"`
}

func (d authDeps) handleSetup(w http.ResponseWriter, r *http.Request) {
	var req setupRequest
	if !ReadJSON(w, r, &req) {
		return
	}
	email := strings.TrimSpace(strings.ToLower(req.Email))
	if !validEmail(email) {
		WriteError(w, http.StatusBadRequest, "INVALID_EMAIL",
			"email is required and must look like an address", nil)
		return
	}
	if err := validatePasswordStrength(req.Password); err != nil {
		WriteError(w, http.StatusBadRequest, "WEAK_PASSWORD",
			err.Error(), nil)
		return
	}

	// Gate: setup only when users is empty. Idempotent in the sense
	// that a second call returns 409; no race where two first-setup
	// requests both "win" — Users.Create on the second will hit a
	// unique-violation and we'll convert to 409.
	count, err := d.users.Count(r.Context())
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"count users: "+err.Error(), nil)
		return
	}
	if count > 0 {
		WriteError(w, http.StatusConflict, "ALREADY_INITIALIZED",
			"setup already completed", nil)
		return
	}

	hash, err := HashPassword(req.Password, d.argon2)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"hash password: "+err.Error(), nil)
		return
	}
	now := time.Now().UTC()
	user := metadata.UserRow{
		ID:           newUserID(),
		Email:        email,
		PasswordHash: hash,
		Role:         "admin",
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := d.users.Create(r.Context(), user); err != nil {
		if errors.Is(err, metadata.ErrUserAlreadyExists) {
			WriteError(w, http.StatusConflict, "ALREADY_INITIALIZED",
				"setup already completed", nil)
			return
		}
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"create user: "+err.Error(), nil)
		return
	}

	// Auto-login: issue the session cookie so the dashboard doesn't have
	// to do a separate /login round-trip right after setup.
	if err := d.issueSession(w, r, &user); err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"issue session: "+err.Error(), nil)
		return
	}
	WriteJSON(w, http.StatusCreated, setupResponse{User: userToResponse(&user)})
}

// --- /auth/login -------------------------------------------------------

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type loginResponse struct {
	User userResponse `json:"user"`
}

func (d authDeps) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if !ReadJSON(w, r, &req) {
		return
	}
	email := strings.TrimSpace(strings.ToLower(req.Email))
	if email == "" || req.Password == "" {
		WriteError(w, http.StatusBadRequest, "MISSING_FIELDS",
			"email and password are required", nil)
		return
	}

	user, err := d.users.GetByEmail(r.Context(), email)
	if err != nil {
		if errors.Is(err, metadata.ErrUserNotFound) {
			// Indistinguishable response from wrong-password — don't
			// help an attacker enumerate valid emails.
			WriteError(w, http.StatusUnauthorized, "UNAUTHENTICATED",
				"invalid email or password", nil)
			return
		}
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"lookup user: "+err.Error(), nil)
		return
	}

	ok, err := VerifyPassword(req.Password, user.PasswordHash)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"verify password: "+err.Error(), nil)
		return
	}
	if !ok {
		WriteError(w, http.StatusUnauthorized, "UNAUTHENTICATED",
			"invalid email or password", nil)
		return
	}

	// Fire-and-forget last-login update — a DB hiccup here shouldn't
	// block the user's login.
	_ = d.users.TouchLogin(r.Context(), user.ID, time.Now().UTC())

	if err := d.issueSession(w, r, user); err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"issue session: "+err.Error(), nil)
		return
	}
	WriteJSON(w, http.StatusOK, loginResponse{User: userToResponse(user)})
}

// --- /auth/logout ------------------------------------------------------

func (d authDeps) handleLogout(w http.ResponseWriter, r *http.Request) {
	// Best-effort revoke of the server-side row. If the cookie's stale
	// or missing we still clear the client-side cookie — logout is never
	// supposed to fail visibly for the user.
	if token := extractSessionToken(r); token != "" {
		if sess, err := d.sessions.Lookup(r.Context(), HashSessionToken(token)); err == nil {
			_ = d.sessions.Revoke(r.Context(), sess.ID)
		}
	}
	ClearSessionCookie(w, r, d.cookie)
	WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// --- /auth/me ----------------------------------------------------------

type userResponse struct {
	ID          string     `json:"id"`
	Email       string     `json:"email"`
	Role        string     `json:"role"`
	CreatedAt   time.Time  `json:"created_at"`
	LastLoginAt *time.Time `json:"last_login_at,omitempty"`
}

func userToResponse(u *metadata.UserRow) userResponse {
	return userResponse{
		ID:          u.ID,
		Email:       u.Email,
		Role:        u.Role,
		CreatedAt:   u.CreatedAt,
		LastLoginAt: u.LastLoginAt,
	}
}

func (d authDeps) handleMe(w http.ResponseWriter, r *http.Request) {
	user := UserFromCtx(r.Context())
	// RequireUser guarantees non-nil, but belt-and-braces:
	if user == nil {
		WriteError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "no session", nil)
		return
	}
	WriteJSON(w, http.StatusOK, userToResponse(user))
}

// --- /auth/change-password ---------------------------------------------

type changePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

func (d authDeps) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	user := UserFromCtx(r.Context())
	if user == nil {
		WriteError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "no session", nil)
		return
	}
	var req changePasswordRequest
	if !ReadJSON(w, r, &req) {
		return
	}
	if err := validatePasswordStrength(req.NewPassword); err != nil {
		WriteError(w, http.StatusBadRequest, "WEAK_PASSWORD", err.Error(), nil)
		return
	}

	ok, err := VerifyPassword(req.CurrentPassword, user.PasswordHash)
	if err != nil || !ok {
		WriteError(w, http.StatusUnauthorized, "UNAUTHENTICATED",
			"current password is incorrect", nil)
		return
	}

	newHash, err := HashPassword(req.NewPassword, d.argon2)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"hash password: "+err.Error(), nil)
		return
	}
	if err := d.users.UpdatePassword(r.Context(), user.ID, newHash); err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"update password: "+err.Error(), nil)
		return
	}

	// Rotate: kill every session owned by this user (including ours),
	// then mint a fresh one so the user stays logged in on this tab.
	// Anyone else who had a cookie gets logged out — which is the point.
	if err := d.sessions.RevokeAllForUser(r.Context(), user.ID); err != nil {
		// Non-fatal — the password has already changed server-side.
		// Log and continue.
	}
	if err := d.issueSession(w, r, user); err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"reissue session: "+err.Error(), nil)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// --- helpers -----------------------------------------------------------

// issueSession creates a row, writes the Set-Cookie header with the
// plaintext token, and never touches `w` on error so the caller can
// still emit a JSON error response.
func (d authDeps) issueSession(w http.ResponseWriter, r *http.Request, user *metadata.UserRow) error {
	token, err := NewSessionToken()
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	row := metadata.UserSessionRow{
		ID:         newSessionID(),
		UserID:     user.ID,
		TokenHash:  HashSessionToken(token),
		CreatedAt:  now,
		ExpiresAt:  now.Add(d.cookie.TTL),
		LastSeenAt: now,
		UserAgent:  r.Header.Get("User-Agent"),
		IP:         clientIP(r),
	}
	if err := d.sessions.Create(r.Context(), row); err != nil {
		return err
	}
	SetSessionCookie(w, r, token, d.cookie)
	return nil
}

// validatePasswordStrength: the bare minimum that still catches "password"
// and "hunter2". Anything stricter is security theater that just annoys
// users into "Password1!" patterns. Length is the dominant factor.
func validatePasswordStrength(p string) error {
	if len(p) < 10 {
		return errors.New("password must be at least 10 characters")
	}
	if len(p) > 1024 {
		return errors.New("password is unreasonably long")
	}
	return nil
}

// validEmail: a low bar — presence of one @ with non-empty sides. Full
// RFC 5322 validation is notoriously useless in practice; we'd rather
// accept a typo and surface it via a login failure than reject a valid
// address with a regex.
func validEmail(s string) bool {
	if s == "" {
		return false
	}
	at := strings.IndexByte(s, '@')
	if at <= 0 || at >= len(s)-1 {
		return false
	}
	if strings.ContainsAny(s, " \t\r\n") {
		return false
	}
	return true
}

// newUserID returns a short, human-safe id.
func newUserID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		panic(err)
	}
	return "user_" + hex.EncodeToString(buf[:])
}

// newSessionID parallels newUserID; kept separate so future features
// (reassigning prefixes, etc.) don't collide.
func newSessionID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		panic(err)
	}
	return "sess_" + hex.EncodeToString(buf[:])
}
