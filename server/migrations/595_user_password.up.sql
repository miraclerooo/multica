CREATE TABLE IF NOT EXISTS user_password (
    user_id uuid NOT NULL,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
