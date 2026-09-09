-- Night desk: shop playbooks, completions, cutover, approvals, on-call, FSM creds, inbound leads, QA

CREATE TABLE IF NOT EXISTS shop_playbooks (
  tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  playbook jsonb NOT NULL DEFAULT '{}'::jsonb,
  owner_can_edit boolean NOT NULL DEFAULT false,
  night_desk_live boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shop_playbook_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version integer NOT NULL,
  playbook jsonb NOT NULL,
  actor text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shop_playbook_versions_tenant_idx
  ON shop_playbook_versions (tenant_id, version DESC);
CREATE UNIQUE INDEX IF NOT EXISTS shop_playbook_versions_tenant_version_uq
  ON shop_playbook_versions (tenant_id, version);

CREATE TABLE IF NOT EXISTS call_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id text NOT NULL,
  completion text NOT NULL,
  reason text,
  booked_cents integer,
  orphan_promise boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'call_end',
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  quote_cents integer,
  fsm_job_id text,
  fsm_provider text,
  recording_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (completion IN ('booked', 'approval_held', 'on_call_paged', 'tasked', 'refused')),
  CHECK (booked_cents IS NULL OR booked_cents >= 0),
  CHECK (quote_cents IS NULL OR quote_cents >= 0),
  UNIQUE (tenant_id, call_id)
);

CREATE INDEX IF NOT EXISTS call_completions_tenant_day_idx
  ON call_completions (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS call_recordings (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id text NOT NULL,
  recording_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, call_id)
);

CREATE TABLE IF NOT EXISTS call_completion_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id text NOT NULL,
  from_completion text,
  to_completion text NOT NULL,
  reason text NOT NULL,
  actor text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (to_completion IN ('booked', 'approval_held', 'on_call_paged', 'tasked', 'refused'))
);

CREATE INDEX IF NOT EXISTS call_completion_events_tenant_idx
  ON call_completion_events (tenant_id, call_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cutover_items (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id text NOT NULL,
  passed boolean NOT NULL DEFAULT false,
  note text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id)
);

CREATE TABLE IF NOT EXISTS booking_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id text,
  status text NOT NULL DEFAULT 'pending',
  summary text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  decided_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE INDEX IF NOT EXISTS booking_approvals_tenant_idx
  ON booking_approvals (tenant_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS booking_approvals_call_pending_uq
  ON booking_approvals (tenant_id, call_id)
  WHERE call_id IS NOT NULL AND status = 'pending';

CREATE TABLE IF NOT EXISTS oncall_rotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label text NOT NULL,
  e164 text NOT NULL,
  weekday smallint,
  start_hhmm text,
  end_hhmm text,
  quiet_hours boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oncall_drills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  e164 text NOT NULL,
  call_control_id text,
  status text NOT NULL DEFAULT 'pending',
  latency_ms integer,
  ok boolean NOT NULL DEFAULT false,
  answered_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oncall_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id text NOT NULL,
  destination_e164 text NOT NULL,
  transfer_call_control_id text,
  status text NOT NULL DEFAULT 'pending',
  deadline_at timestamptz NOT NULL,
  answered_at timestamptz,
  failed_at timestamptz,
  fallback_tasked_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('pending', 'processing', 'answered', 'failed', 'tasked')),
  UNIQUE (tenant_id, call_id)
);

CREATE INDEX IF NOT EXISTS oncall_pages_due_idx
  ON oncall_pages (status, deadline_at)
  WHERE status IN ('pending', 'processing', 'failed');

CREATE TABLE IF NOT EXISTS fsm_connections (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'disconnected',
  account_label text,
  account_id text,
  scopes text[] NOT NULL DEFAULT '{}'::text[],
  token_expires_at timestamptz,
  refresh_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider)
);

CREATE TABLE IF NOT EXISTS fsm_job_writes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL,
  idempotency_key text NOT NULL,
  call_id text NOT NULL,
  customer_id text,
  property_id text,
  job_id text,
  status text NOT NULL,
  error text,
  response jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, idempotency_key)
);

CREATE TABLE IF NOT EXISTS inbound_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source text NOT NULL,
  name text,
  phone text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  completion text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS call_qa_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id text NOT NULL,
  score integer NOT NULL,
  rubric jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, call_id),
  CHECK (score >= 0 AND score <= 100)
);

CREATE TABLE IF NOT EXISTS morning_digest_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  channel text NOT NULL,
  destination_hash text NOT NULL,
  status text NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, local_date, channel, destination_hash)
);

-- @down
DROP TABLE IF EXISTS morning_digest_deliveries;
DROP TABLE IF EXISTS call_qa_scores;
DROP TABLE IF EXISTS inbound_leads;
DROP TABLE IF EXISTS fsm_job_writes;
DROP TABLE IF EXISTS fsm_connections;
DROP TABLE IF EXISTS oncall_pages;
DROP TABLE IF EXISTS oncall_drills;
DROP TABLE IF EXISTS oncall_rotations;
DROP TABLE IF EXISTS booking_approvals;
DROP TABLE IF EXISTS cutover_items;
DROP TABLE IF EXISTS call_completion_events;
DROP TABLE IF EXISTS call_recordings;
DROP TABLE IF EXISTS call_completions;
DROP TABLE IF EXISTS shop_playbook_versions;
DROP TABLE IF EXISTS shop_playbooks;
