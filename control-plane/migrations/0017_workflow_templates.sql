-- Workflow template gallery: bind instances to catalog ids and track delayed follow-ups.

ALTER TABLE workflows
  ADD COLUMN IF NOT EXISTS template_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_tenant_template
  ON workflows (tenant_id, template_id)
  WHERE template_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workflow_followups (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id  TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  call_id      TEXT,
  kind         TEXT NOT NULL,
  due_at       TIMESTAMPTZ NOT NULL,
  sent_at      TIMESTAMPTZ,
  payload      JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, call_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_workflow_followups_due
  ON workflow_followups (tenant_id, kind, due_at)
  WHERE sent_at IS NULL;
