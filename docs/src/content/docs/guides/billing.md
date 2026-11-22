---
title: Billing
description: Local subscription mirror, webhook sync, and plan-gating middleware — a Cashier-style billing layer for Hono.
---

`hono-stripe/billing` maintains a local mirror of Stripe customer/subscription
state, kept current by webhook handlers, so entitlement checks and plan gates
hit your own database instead of the Stripe API.

```ts
import { stripeBilling, sqlBillingStore } from 'hono-stripe/billing'
import { stripeWebhook, mergeWebhookHandlers } from 'hono-stripe/webhook'
```

## How it works

Every `checkout.session.completed` / `customer.subscription.*` webhook event
re-fetches the subscription from the Stripe API and writes it through an
**atomic timestamp guard** in the store — an older or duplicate delivery can
never regress the mirror. When two events share the same second, the mirror
row is re-read from the API and written unconditionally. This ordering
protocol was model-checked (Quint/Alloy, `spec/`) and is the only variant
proven to converge under duplicate, out-of-order, and concurrent deliveries.

The store interface is `BillingStore`. Two adapters ship:

| Adapter | Use for |
| -- | -- |
| `sqlBillingStore(execute, { dialect })` | Production — atomic guard via SQL (`sqlite` or `pg`) |
| `memoryBillingStore()` | Dev and tests |

**Cloudflare Workers KV cannot be a correctness-complete mirror** — it has
no atomic check-and-write and read-after-write is eventually consistent
(~60s). If you must read billing data from KV, treat `sqlBillingStore` as the
source of truth and project a denormalized view, repaired by
`syncFromStripe()`.

## Setup

### 1. Create the tables

Apply the shipped DDL with your own migration tool:

```ts
import { BILLING_SCHEMA_SQLITE, BILLING_SCHEMA_PG } from 'hono-stripe/billing/schema'
```

### 2. Configure the factory

```ts
const billing = stripeBilling({
  // Any driver — wrap it in the 5-line executor interface:
  store: (c) =>
    sqlBillingStore((sql, params = []) =>
      c.env.DB.prepare(sql).bind(...params).all().then((r) => r.results),
    ),
  plans: { pro: 'price_pro_monthly', team: ['price_team_m', 'price_team_y'] },
  user: (c) => c.get('authUser').id, // your auth — package is auth-agnostic
})
```

### 3. Link users in checkout

```ts
await stripe.checkout.sessions.create({
  mode: 'subscription',
  line_items: [{ price: 'price_pro_monthly', quantity: 1 }],
  success_url: '...',
  ...billing.checkoutParams(userId), // client_reference_id + metadata
})
```

`checkoutParams` populates every linkable field so the webhook can resolve
the application user without an API round-trip.

### 4. Wire the webhook

```ts
app.post('/webhook', stripeWebhook({
  dedupe: (c) => kvEventStore(c.env.STRIPE_EVENTS),
  on: mergeWebhookHandlers(billing.handlers, {
    'checkout.session.completed': async (event) => {
      await provisionAccount(event.data.object)
    },
  }),
}))
```

`mergeWebhookHandlers` sequences handlers registered for the same event
type — `billing.handlers` runs first, your handler second. (Returning a
`Response` from your handler replaces the default reply.)

## Entitlement

```ts
app.use('/pro/*', billing.middleware())
app.get('/pro/data', billing.requirePlan(['pro', 'team']), (c) => {
  const { subscription, currentPeriodEnd } = c.get('billing')
})
```

- `billing.getState(c)` — `{ entitled, plan, status, subscription, … }`
- `billing.requirePlan('pro' | ['pro', 'team'], opts)` — `403 { error:
  'plan_required' }` by default; `opts.onDenied`, `opts.redirect`, and
  `opts.allowedStatuses` (e.g. include `past_due` during a grace period)
  customize it.
- `billing.getSubscriptions(c)` — all mirror rows for the user.

`entitled` means the deterministic "best" subscription has status `active`
or `trialing` (`allowedStatuses` overrides). Deterministic pick order:
status rank → newest `lastEventCreated` → id.

## userId resolution order

1. `checkout.session.completed`'s `client_reference_id`
2. Checkout Session metadata
3. Subscription metadata (`subscription.metadata.user_id` — or your
   `userIdKey`)
4. Customer metadata / existing `stripe_customers` row

A paid subscription with no resolvable user is **not written** — it is
reported via `warn` so you can reconcile, instead of silently producing an
orphan row.

## Idempotency

Dedupe means "an event won't re-enter the map **after** a successful
handler" — not exactly-once. Handlers that throw are retried by Stripe, so
user-side effects must be idempotent (the billing mirror itself is
idempotent by the timestamp guard).

## Reconciliation

`billing.syncFromStripe(c)` re-reads the user's subscriptions from the API
and rewrites the mirror — use it to repair drift, or to drive a first-time
backfill for existing Stripe customers.
