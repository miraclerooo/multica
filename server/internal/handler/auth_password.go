package handler

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/auth"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func passwordLoginEnabled() bool {
	return os.Getenv("MULTICA_PASSWORD_LOGIN") == "true"
}

type passwordLoginRequest struct {
	Email      string `json:"email"`
	Password   string `json:"password"`
	SetupToken string `json:"setup_token"`
}

// The initial password is bound to an existing account and a short-lived
// operator-issued token. An existing password can never be replaced here.
func validPasswordSetup(email, token string) bool {
	if len(token) < 32 || len(token) > 256 || !strings.EqualFold(email, strings.TrimSpace(os.Getenv("MULTICA_PASSWORD_SETUP_EMAIL"))) {
		return false
	}
	expires, err := time.Parse(time.RFC3339, os.Getenv("MULTICA_PASSWORD_SETUP_EXPIRES_AT"))
	if err != nil || !time.Now().Before(expires) {
		return false
	}
	want, err := hex.DecodeString(os.Getenv("MULTICA_PASSWORD_SETUP_TOKEN_SHA256"))
	if err != nil || len(want) != sha256.Size {
		return false
	}
	got := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(got[:], want) == 1
}

func (h *Handler) PasswordLogin(w http.ResponseWriter, r *http.Request) {
	h.passwordLogin(w, r, false)
}

func (h *Handler) SetupPassword(w http.ResponseWriter, r *http.Request) {
	h.passwordLogin(w, r, true)
}

func (h *Handler) passwordLogin(w http.ResponseWriter, r *http.Request, setup bool) {
	if !passwordLoginEnabled() {
		writeError(w, http.StatusNotFound, "password login is not enabled")
		return
	}
	// Requiring JSON forces cross-origin browser requests through CORS preflight.
	mediaType, _, mediaErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaErr != nil || mediaType != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "application/json is required")
		return
	}
	var req passwordLoginRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if email == "" || req.Password == "" || len(req.Password) > 512 {
		writeError(w, http.StatusBadRequest, "email and password are required (maximum 512 password bytes)")
		return
	}
	if setup && !validPasswordSetup(email, req.SetupToken) {
		writeError(w, http.StatusUnauthorized, "invalid or expired password setup link")
		return
	}
	user, err := h.Queries.GetUserByEmail(r.Context(), email)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "could not sign in")
		return
	}
	if errors.Is(err, pgx.ErrNoRows) || auth.IsTemporarilyDisabledUser(uuidToString(user.ID), email) {
		// Match the expensive password check without exposing account existence.
		_, _ = auth.HashPassword("invalid-account-dummy-password")
		writeError(w, http.StatusUnauthorized, "invalid email or password")
		return
	}
	if setup {
		hash, err := auth.HashPassword(req.Password)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		rows, err := h.Queries.CreateUserPassword(r.Context(), db.CreateUserPasswordParams{UserID: user.ID, PasswordHash: hash})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not set password")
			return
		}
		if rows != 1 {
			writeError(w, http.StatusConflict, "password has already been set")
			return
		}
	} else {
		hash, err := h.Queries.GetUserPassword(r.Context(), user.ID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusInternalServerError, "could not sign in")
			return
		}
		if errors.Is(err, pgx.ErrNoRows) {
			_, _ = auth.HashPassword("invalid-account-dummy-password")
			writeError(w, http.StatusUnauthorized, "invalid email or password")
			return
		}
		if !auth.CheckPassword(hash, req.Password) {
			writeError(w, http.StatusUnauthorized, "invalid email or password")
			return
		}
	}
	token, err := h.issueJWT(user)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not sign in")
		return
	}
	if err := auth.SetAuthCookies(w, token); err != nil {
		writeError(w, http.StatusInternalServerError, "could not set session")
		return
	}
	writeJSON(w, http.StatusOK, LoginResponse{Token: token, User: h.userToResponse(user)})
}
