-- Email + password login for the client portal (replaces phone+passcode for new setups)

CREATE TABLE IF NOT EXISTS owner_portal_credentials (
  tenant_id     TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  email_norm    TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_owner_portal_credentials_email
  ON owner_portal_credentials (email_norm);

-- @down
DROP TABLE IF EXISTS owner_portal_credentials;
