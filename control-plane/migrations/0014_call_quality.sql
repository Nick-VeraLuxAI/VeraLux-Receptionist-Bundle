-- Call Quality Analytics + Raw Audio Diagnostics (tenant-scoped)

CREATE TABLE IF NOT EXISTS tenant_call_quality_settings (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,

  call_quality_analytics_enabled BOOLEAN NOT NULL DEFAULT true,
  transcript_storage_enabled BOOLEAN NOT NULL DEFAULT true,
  transcript_retention_days INTEGER NOT NULL DEFAULT 30
    CHECK (transcript_retention_days >= 1 AND transcript_retention_days <= 365),

  raw_audio_diagnostics_mode TEXT NOT NULL DEFAULT 'off'
    CHECK (raw_audio_diagnostics_mode IN (
      'off',
      'next_call_only',
      'failed_calls_only',
      'all_calls_temporary'
    )),
  raw_audio_diagnostics_expires_at TIMESTAMPTZ,
  raw_audio_diagnostics_enabled_by TEXT,
  raw_audio_diagnostics_reason TEXT,
  raw_audio_diagnostics_next_call_pending BOOLEAN NOT NULL DEFAULT false,

  quality_summary_visible_to_client BOOLEAN NOT NULL DEFAULT true,
  raw_artifacts_visible_to_client BOOLEAN NOT NULL DEFAULT false,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tcq_settings_expires
  ON tenant_call_quality_settings (raw_audio_diagnostics_expires_at)
  WHERE raw_audio_diagnostics_mode = 'all_calls_temporary';

-- Per-call quality summaries (keyed by Telnyx call_control_id from voice runtime)
CREATE TABLE IF NOT EXISTS call_quality_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_control_id TEXT NOT NULL,
  summary JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, call_control_id)
);

CREATE INDEX IF NOT EXISTS idx_call_quality_summaries_tenant_updated
  ON call_quality_summaries (tenant_id, updated_at DESC);

-- Richer audit payloads (no secrets — callers must avoid storing credentials)
ALTER TABLE admin_audit_logs
  ADD COLUMN IF NOT EXISTS details JSONB;

-- @down
ALTER TABLE admin_audit_logs DROP COLUMN IF EXISTS details;
DROP TABLE IF EXISTS call_quality_summaries;
DROP TABLE IF EXISTS tenant_call_quality_settings;
