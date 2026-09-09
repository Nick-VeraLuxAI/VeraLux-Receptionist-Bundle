-- Live Stripe catalog wiring: webhook idempotency + current period on the tenant billing record.

ALTER TABLE tenant_subscriptions
  ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMPTZ;

ALTER TABLE tenant_subscriptions
  ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  tenant_id    TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sub_stripe_subscription
  ON tenant_subscriptions (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
