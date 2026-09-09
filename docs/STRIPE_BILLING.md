# Stripe billing (live Receptionist catalog)

VeraLux staff create subscriptions from **existing** Stripe Prices. The control plane does **not** create or archive Products/Prices.

## Environment (server-only)

| Variable | Required | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | Yes, to enable billing | Prefer a restricted key (`rk_…`). Live keys (`sk_live` / `rk_live`) require an explicit staff confirm on create/cancel. |
| `STRIPE_PUBLISHABLE_KEY` | Optional | Never sent to the owner portal. |
| `STRIPE_WEBHOOK_SECRET` | Yes, for webhooks | Signing secret from the Stripe Dashboard endpoint. |
| `CONTROL_PLANE_PUBLIC_URL` | Recommended | Used to print the webhook URL. Also accepts `PUBLIC_BASE_URL` / `BASE_URL`. |

Optional price-id overrides (defaults are the live Receptionist catalog):

| Env | Lookup key | Default | Role |
|---|---|---|---|
| `STRIPE_PRICE_RECEPTIONIST_LIST_MONTHLY` | `receptionist_list_monthly` | `price_1UCoHhJySNqJ528kpvc2i0nc` | Professional $2000/mo |
| `STRIPE_PRICE_RECEPTIONIST_SETUP` | `receptionist_setup` | `price_1UCoHiJySNqJ528kzbiILgGo` | $5000 one-time |
| `STRIPE_PRICE_RECEPTIONIST_PILOT_MONTHLY` | `receptionist_pilot_monthly` | `price_1UCoHjJySNqJ528kJyA2NnNK` | Pilot $1500/mo |
| `STRIPE_PRICE_RECEPTIONIST_PILOT_SETUP` | `receptionist_pilot_setup` | `price_1UCoHjJySNqJ528kmVqpmu2H` | $3500 one-time |

Prices are matched by `lookup_key`, `metadata.sku`, or these IDs.

## Webhook (Stripe Dashboard)

**Endpoint URL**

```
POST {CONTROL_PLANE_PUBLIC_URL}/api/stripe/webhook
```

Example: `https://receptionist.example.com/api/stripe/webhook`

**Events to enable**

- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`
- `checkout.session.completed` (optional, if staff use Checkout)

The handler verifies `Stripe-Signature` with `STRIPE_WEBHOOK_SECRET` and is idempotent (`stripe_webhook_events.event_id`).

**Tax:** `automatic_tax` is not enabled. Turn it on only after Stripe Tax registrations exist.

## Staff (`/admin/billing`)

1. Select a monthly catalog price.
2. Optionally **Include setup** (adds the matching one-time price to the first invoice).
3. **Create subscription** — live keys show a confirm dialog. The API rejects create/cancel without `confirm: true` when using live keys.
4. **Sync from Stripe** refreshes customer + subscription onto the tenant.
5. **Allow self-service billing** stores `showBillingPortal`. When on, the owner can open the Stripe Customer Portal.

Create/cancel/sync/portal-toggle are audited (`stripe.subscription.create`, `stripe.sync`, `stripe.portal.toggle`).

## Owner (`/portal/billing`)

- No Stripe subscription → **NOT CONFIGURED** / VeraLux will set this up.
- Subscribed → plan name, amount, status, current period, usage.
- Self-service on → **Manage billing** opens a Billing Portal session with `return_url=/portal/billing`.
- Owners never receive secret keys and cannot pick arbitrary prices.

## Badges

| Badge | Source | Examples |
|---|---|---|
| **Plan** | Entitlements `planName` | Professional, Pilot |
| **Service** | Entitlements `billingStatus` (staff-controlled) | Active, Trial, Suspended |
| **Billing** | Stripe subscription | Subscribed, Unbilled, Past due, Canceled |

A tenant can be Plan=Professional, Service=Active, Billing=Unbilled. Voice is not auto-killed on `past_due` or Stripe cancel; only staff **Service** `suspended` / `canceled` stops the receptionist.

## Plans & limits

`/admin/plans` stays independently editable. Creating/syncing a catalog subscription sets **plan name/tier** to Professional or Pilot to match the SKU. It does not invent MRR without a Stripe subscription.
