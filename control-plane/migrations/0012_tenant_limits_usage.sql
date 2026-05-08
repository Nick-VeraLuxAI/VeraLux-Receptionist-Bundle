-- Tenant plan limits and usage accounting for paid deployments

CREATE TABLE IF NOT EXISTS tenant_limits (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,

  plan_name TEXT NOT NULL DEFAULT 'Professional',
  plan_tier TEXT NOT NULL DEFAULT 'professional'
    CHECK (plan_tier IN ('starter', 'professional', 'premium', 'enterprise')),
  billing_status TEXT NOT NULL DEFAULT 'active'
    CHECK (billing_status IN ('trial', 'active', 'past_due', 'suspended', 'canceled')),
  overage_mode TEXT NOT NULL DEFAULT 'allow_and_bill'
    CHECK (overage_mode IN ('allow_and_bill', 'throttle', 'hard_stop')),
  monthly_minute_overage_rate_cents INTEGER NOT NULL DEFAULT 35 CHECK (monthly_minute_overage_rate_cents >= 0),
  effective_from TIMESTAMPTZ,
  effective_until TIMESTAMPTZ,

  max_concurrent_calls INTEGER NOT NULL DEFAULT 3 CHECK (max_concurrent_calls > 0),
  included_monthly_minutes INTEGER NOT NULL DEFAULT 1200 CHECK (included_monthly_minutes >= 0),
  max_monthly_minutes_hard_cap INTEGER NOT NULL DEFAULT 3000 CHECK (max_monthly_minutes_hard_cap >= 0),
  max_daily_calls INTEGER NOT NULL DEFAULT 250 CHECK (max_daily_calls >= 0),
  max_monthly_calls INTEGER NOT NULL DEFAULT 5000 CHECK (max_monthly_calls >= 0),
  max_knowledge_base_size_mb INTEGER NOT NULL DEFAULT 128 CHECK (max_knowledge_base_size_mb >= 0),
  max_integrations INTEGER NOT NULL DEFAULT 5 CHECK (max_integrations >= 0),
  max_locations INTEGER NOT NULL DEFAULT 3 CHECK (max_locations >= 0),
  max_phone_numbers INTEGER NOT NULL DEFAULT 10 CHECK (max_phone_numbers >= 0),
  max_admin_users INTEGER NOT NULL DEFAULT 10 CHECK (max_admin_users >= 0),
  max_escalation_contacts INTEGER NOT NULL DEFAULT 20 CHECK (max_escalation_contacts >= 0),

  after_hours_mode BOOLEAN NOT NULL DEFAULT true,
  sms_followup BOOLEAN NOT NULL DEFAULT true,
  calendar_integration BOOLEAN NOT NULL DEFAULT true,
  crm_integration BOOLEAN NOT NULL DEFAULT true,
  advanced_analytics BOOLEAN NOT NULL DEFAULT true,
  call_recording BOOLEAN NOT NULL DEFAULT false,
  transcript_retention BOOLEAN NOT NULL DEFAULT true,
  multi_location BOOLEAN NOT NULL DEFAULT true,
  custom_workflows BOOLEAN NOT NULL DEFAULT true,
  priority_support BOOLEAN NOT NULL DEFAULT false,

  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_usage_daily (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL,
  calls_count INTEGER NOT NULL DEFAULT 0 CHECK (calls_count >= 0),
  billable_minutes INTEGER NOT NULL DEFAULT 0 CHECK (billable_minutes >= 0),
  fallback_usage_count INTEGER NOT NULL DEFAULT 0 CHECK (fallback_usage_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, usage_date)
);

CREATE TABLE IF NOT EXISTS tenant_usage_monthly (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usage_month TEXT NOT NULL, -- YYYY-MM
  calls_count INTEGER NOT NULL DEFAULT 0 CHECK (calls_count >= 0),
  billable_minutes INTEGER NOT NULL DEFAULT 0 CHECK (billable_minutes >= 0),
  fallback_usage_count INTEGER NOT NULL DEFAULT 0 CHECK (fallback_usage_count >= 0),
  provider_usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, usage_month)
);

INSERT INTO tenant_limits (tenant_id)
SELECT t.id
FROM tenants t
LEFT JOIN tenant_limits l ON l.tenant_id = t.id
WHERE l.tenant_id IS NULL;

-- @down
DROP TABLE IF EXISTS tenant_usage_monthly;
DROP TABLE IF EXISTS tenant_usage_daily;
DROP TABLE IF EXISTS tenant_limits;
