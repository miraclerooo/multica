-- name: GetUserPassword :one
SELECT password_hash FROM user_password WHERE user_id = $1;

-- name: CreateUserPassword :execrows
INSERT INTO user_password (user_id, password_hash) VALUES ($1, $2)
ON CONFLICT (user_id) DO NOTHING;
