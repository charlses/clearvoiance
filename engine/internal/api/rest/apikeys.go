package rest

import (
	"crypto/rand"
	"encoding/base32"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/charlses/clearvoiance/engine/internal/storage/metadata"
)

type apiKeyView struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	CreatedAt  string  `json:"created_at"`
	RevokedAt  *string `json:"revoked_at,omitempty"`
	LastUsedAt *string `json:"last_used_at,omitempty"`
}

type createAPIKeyReq struct {
	Name string `json:"name"`
}

type createAPIKeyResp struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Key       string `json:"key"`
	CreatedAt string `json:"created_at"`
	Warning   string `json:"warning"`
}

func mountAPIKeys(r chi.Router, d Deps) {
	h := &apiKeyHandler{keys: d.MetaStore.APIKeys()}
	r.Route("/api-keys", func(r chi.Router) {
		r.Post("/", h.create)
		r.Get("/", h.list)
		r.Delete("/{id}", h.revoke)
	})
}

type apiKeyHandler struct {
	keys metadata.APIKeys
}

func (h *apiKeyHandler) create(w http.ResponseWriter, r *http.Request) {
	var req createAPIKeyReq
	if !ReadJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		WriteError(w, http.StatusBadRequest, "BAD_REQUEST",
			"name is required", nil)
		return
	}

	plain, err := generateAPIKey()
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"generate key: "+err.Error(), nil)
		return
	}
	id := uuid.NewString()
	hash := HashAPIKey(plain)
	if err := h.keys.Create(r.Context(), id, hash, req.Name); err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"create key: "+err.Error(), nil)
		return
	}

	WriteJSON(w, http.StatusCreated, createAPIKeyResp{
		ID:        id,
		Name:      req.Name,
		Key:       plain,
		CreatedAt: time.Now().UTC().Format("2006-01-02T15:04:05.999Z07:00"),
		Warning:   "Store this key now. The plaintext is not recoverable after this response.",
	})
}

func (h *apiKeyHandler) list(w http.ResponseWriter, r *http.Request) {
	rows, err := h.keys.List(r.Context())
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"list keys: "+err.Error(), nil)
		return
	}
	out := make([]apiKeyView, 0, len(rows))
	for _, r := range rows {
		out = append(out, toAPIKeyView(r))
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"keys":  out,
		"count": len(out),
	})
}

func (h *apiKeyHandler) revoke(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.keys.Revoke(r.Context(), id); err != nil {
		if errors.Is(err, metadata.ErrAPIKeyNotFound) {
			WriteError(w, http.StatusNotFound, "API_KEY_NOT_FOUND",
				"API key "+id+" not found or already revoked", nil)
			return
		}
		WriteError(w, http.StatusInternalServerError, "INTERNAL",
			"revoke key: "+err.Error(), nil)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func toAPIKeyView(k metadata.APIKeyRow) apiKeyView {
	v := apiKeyView{
		ID:        k.ID,
		Name:      k.Name,
		CreatedAt: k.CreatedAt.Format("2006-01-02T15:04:05.999Z07:00"),
	}
	if k.RevokedAt != nil {
		t := k.RevokedAt.Format("2006-01-02T15:04:05.999Z07:00")
		v.RevokedAt = &t
	}
	if k.LastUsedAt != nil {
		t := k.LastUsedAt.Format("2006-01-02T15:04:05.999Z07:00")
		v.LastUsedAt = &t
	}
	return v
}

// generateAPIKey mints a new key of the form `clv_live_<base32>`. Uses 128
// random bits (matches the CLI's implementation so keys look uniform
// regardless of where they were minted).
func generateAPIKey() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	enc := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf[:])
	return "clv_live_" + strings.ToLower(enc), nil
}
