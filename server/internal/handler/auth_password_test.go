package handler

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestPasswordSetupAndLogin(t *testing.T) {
	t.Setenv("MULTICA_PASSWORD_LOGIN", "true")
	email := "password-login-test@example.com"
	uid := dbfx.User(t, "Password Test", email)
	dbfx.Cleanup(t, "DELETE FROM user_password WHERE user_id = $1", parseUUID(uid))
	token := strings.Repeat("s", 43)
	hash := sha256.Sum256([]byte(token))
	t.Setenv("MULTICA_PASSWORD_SETUP_EMAIL", email)
	t.Setenv("MULTICA_PASSWORD_SETUP_TOKEN_SHA256", hex.EncodeToString(hash[:]))
	t.Setenv("MULTICA_PASSWORD_SETUP_EXPIRES_AT", time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
	plain := testutil.JSONRequest(http.MethodPost, "/auth/password", map[string]string{"email": email, "password": "known-password"})
	plain.Header.Set("Content-Type", "text/plain")
	testutil.Call(t, testHandler.PasswordLogin, plain).Want(http.StatusUnsupportedMediaType)
	body := map[string]string{"email": email, "password": "correct horse battery staple", "setup_token": token}
	body["setup_token"] = "incorrect"
	testutil.Call(t, testHandler.SetupPassword, testutil.JSONRequest(http.MethodPost, "/auth/password/setup", body)).Want(http.StatusUnauthorized)
	body["setup_token"] = token
	t.Setenv("MULTICA_PASSWORD_SETUP_EXPIRES_AT", time.Now().Add(-time.Minute).UTC().Format(time.RFC3339))
	testutil.Call(t, testHandler.SetupPassword, testutil.JSONRequest(http.MethodPost, "/auth/password/setup", body)).Want(http.StatusUnauthorized)
	t.Setenv("MULTICA_PASSWORD_SETUP_EXPIRES_AT", time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
	response := testutil.Call(t, testHandler.SetupPassword, testutil.JSONRequest(http.MethodPost, "/auth/password/setup", body)).Want(http.StatusOK)
	if len(response.Result().Cookies()) == 0 {
		t.Fatal("no auth cookies")
	}
	testutil.Call(t, testHandler.SetupPassword, testutil.JSONRequest(http.MethodPost, "/auth/password/setup", body)).Want(http.StatusConflict)
	delete(body, "setup_token")
	testutil.Call(t, testHandler.PasswordLogin, testutil.JSONRequest(http.MethodPost, "/auth/password", body)).Want(http.StatusOK)
	body["password"] = "wrong password"
	bad := testutil.Call(t, testHandler.PasswordLogin, testutil.JSONRequest(http.MethodPost, "/auth/password", body)).Want(http.StatusUnauthorized).Map()
	body["email"] = "nonexistent-password-test@example.com"
	absent := testutil.Call(t, testHandler.PasswordLogin, testutil.JSONRequest(http.MethodPost, "/auth/password", body)).Want(http.StatusUnauthorized).Map()
	if bad["error"] != absent["error"] {
		t.Fatal("login reveals account existence")
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM "user" WHERE email=$1`, body["email"]); n != 0 {
		t.Fatal("login created an account")
	}
	testutil.Call(t, testHandler.SendCode, testutil.JSONRequest(http.MethodPost, "/auth/send-code", body)).Want(http.StatusForbidden)
	testutil.Call(t, testHandler.VerifyCode, testutil.JSONRequest(http.MethodPost, "/auth/verify-code", body)).Want(http.StatusForbidden)
	t.Setenv("MULTICA_PASSWORD_LOGIN", "false")
	testutil.Call(t, testHandler.PasswordLogin, testutil.JSONRequest(http.MethodPost, "/auth/password", body)).Want(http.StatusNotFound)
}
