-- In-app staff console email + password (overrides INSTALLER_PASSWORD after first save).

CREATE TABLE IF NOT EXISTS console_credentials (
  id            TEXT PRIMARY KEY DEFAULT 'console' CHECK (id = 'console'),
  email_norm    TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- @down
DROP TABLE IF EXISTS console_credentials;
