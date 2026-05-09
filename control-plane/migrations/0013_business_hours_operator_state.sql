-- Sprint 1: business hours + operator handoff state (test call marker) per tenant
alter table tenant_configs
  add column if not exists business_hours jsonb not null default '{}'::jsonb;

alter table tenant_configs
  add column if not exists operator_state jsonb not null default '{}'::jsonb;

-- @down
alter table tenant_configs drop column if exists operator_state;
alter table tenant_configs drop column if exists business_hours;
