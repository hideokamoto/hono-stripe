# hono-stripe — Cloudflare Workers starter

A minimal, full-stack Stripe payment app on **Hono + Cloudflare Workers**, all
wired through [`hono-stripe`](../../):

| Piece | Module | What it does here |
| -- | -- | -- |
| Intent / Session creation | `hono-stripe` | `POST /api/payment-intent`, `POST /api/checkout-session` — direct `stripe` SDK calls on the `c.var.stripe` client injected by `stripeMiddleware()` |
| Webhook receiving | `hono-stripe/webhook` | `POST /api/webhook` — signature verification, typed per-event routing, delivery dedupe |
| Payment UI | `hono-stripe/ui` | `<stripe-payment-element>` (stripe-pwa-elements) rendered via `hono/jsx` — no React, no frontend build |

Two payment flows are included: **Payment Element** (PaymentIntent, on `/`) and
**Checkout Session** (`/checkout`).

## Setup (3 steps)

```sh
# 1. Install
pnpm install

# 2. Add your Stripe TEST keys
cp .dev.vars.example .dev.vars
#   then edit .dev.vars and set STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET /
#   STRIPE_PUBLISHABLE_KEY (use test keys only — sk_test_ / pk_test_).

# 3. Run
pnpm dev          # http://localhost:8787
```

> Test keys only. Never commit `.dev.vars` or put live (`sk_live_`/`pk_live_`)
> keys in this repo. The publishable key (`pk_test_`) is sent to the browser by
> design; the secret key never leaves the Worker.

### Testing webhooks locally

```sh
stripe listen --forward-to localhost:8787/api/webhook
```

Copy the `whsec_...` it prints into `STRIPE_WEBHOOK_SECRET` in `.dev.vars`.

For unit tests instead of live events, `hono-stripe/testing` can generate
requests with real signatures — see the main README.

## Deploy

```sh
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
# set the publishable key in wrangler.toml [vars], then:
pnpm deploy
```

## Notes

- This example lives in the `hono-stripe` repo and depends on the library via
  `workspace:*`. As a standalone template you would instead depend on the
  published `hono-stripe` from npm.
- `compatibility_flags = ["nodejs_compat"]` is enabled for the Stripe SDK. On
  Workers, `hono-stripe` applies `Stripe.createFetchHttpClient()` automatically.
- The example dedupes webhook deliveries with `memoryEventStore` (per-isolate,
  dev-grade). For production back it with Workers KV:
  `dedupe: (c) => kvEventStore(c.env.STRIPE_EVENTS)` with a
  `[[kv_namespaces]]` binding.
