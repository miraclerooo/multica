package auth

import (
	"strings"
	"testing"
)

func TestPasswordHash(t *testing.T) {
	password := "a long unique password 密码"
	first, err := HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	second, err := HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	if first == second || strings.Contains(first, password) {
		t.Fatal("password hashes must be salted and not contain plaintext")
	}
	if !CheckPassword(first, password) || CheckPassword(first, password+"x") {
		t.Fatal("password verification mismatch")
	}
	for _, invalid := range []string{"", "pbkdf2-sha256$1$a$b", "pbkdf2-sha256$600000$invalid$invalid", first + "$extra"} {
		if CheckPassword(invalid, password) {
			t.Fatal("accepted invalid hash")
		}
	}
	for _, invalid := range []string{"short", strings.Repeat("x", 513)} {
		if _, err := HashPassword(invalid); err == nil {
			t.Fatal("accepted invalid password length")
		}
	}
}
