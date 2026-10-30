package main

import (
	"net/http"
	"strings"
	"testing"
)

func TestPasswordLoginRequiresRateLimiter(t *testing.T) {
	t.Setenv("MULTICA_PASSWORD_LOGIN", "true")
	for _, path := range []string{"/auth/password", "/auth/password/setup"} {
		response, err := http.Post(testServer.URL+path, "application/json", strings.NewReader(`{"email":"owner@example.com","password":"not-a-real-password"}`))
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("%s without Redis: got %d", path, response.StatusCode)
		}
	}
}
