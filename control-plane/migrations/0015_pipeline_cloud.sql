-- Cloud pipeline catalog, rate cards, deployments, and provision jobs

CREATE TABLE IF NOT EXISTS pipeline_components (
  sku TEXT PRIMARY KEY,
  slot TEXT NOT NULL,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  host_ok BOOLEAN NOT NULL DEFAULT false,
  onprem_ok BOOLEAN NOT NULL DEFAULT true,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS rate_card_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of TIMESTAMPTZ NOT NULL DEFAULT now(),
  prices JSONB NOT NULL,
  sources JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_card_versions_as_of
  ON rate_card_versions (as_of DESC);

CREATE TABLE IF NOT EXISTS price_feed_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  sources JSONB NOT NULL DEFAULT '{}'::jsonb,
  unmapped_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_summary TEXT,
  rate_card_id UUID REFERENCES rate_card_versions(id)
);

CREATE INDEX IF NOT EXISTS idx_price_feed_runs_started
  ON price_feed_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS price_overrides (
  sku TEXT NOT NULL,
  unit TEXT NOT NULL,
  millicents INTEGER NOT NULL,
  reason TEXT,
  set_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sku, unit)
);

CREATE TABLE IF NOT EXISTS tenant_pipelines (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'estimated', 'provisioning', 'ready', 'failed')),
  host_sku TEXT,
  telco_sku TEXT NOT NULL DEFAULT 'telnyx:inbound',
  stt_sku TEXT,
  llm_sku TEXT,
  tts_sku TEXT,
  assumptions JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_estimate JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  region TEXT,
  size TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'provisioning', 'ready', 'failed', 'canceled')),
  control_url TEXT,
  runtime_url TEXT,
  handles JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_deployments_one_active
  ON tenant_deployments (tenant_id)
  WHERE status IN ('pending', 'provisioning', 'ready');

CREATE TABLE IF NOT EXISTS provision_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  deployment_id UUID REFERENCES tenant_deployments(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'ready', 'failed', 'canceled')),
  step TEXT,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_redacted TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provision_jobs_tenant
  ON provision_jobs (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  cipher TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- @down
DROP TABLE IF EXISTS platform_settings;
DROP TABLE IF EXISTS provision_jobs;
DROP TABLE IF EXISTS tenant_deployments;
DROP TABLE IF EXISTS tenant_pipelines;
DROP TABLE IF EXISTS price_overrides;
DROP TABLE IF EXISTS price_feed_runs;
DROP TABLE IF EXISTS rate_card_versions;
DROP TABLE IF EXISTS pipeline_components;
