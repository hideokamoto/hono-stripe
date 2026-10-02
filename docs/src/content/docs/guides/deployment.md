---
title: Deployment
description: Runtime notes for Cloudflare Workers, Node, and production hardening.
---

## Cloudflare Workers

- `nodejs_compat` is recommended for the Stripe SDK — `hono-stripe` applies
  `Stripe.createFetchHttpClient()` automatically so the SDK works without
  Node's HTTP stack.
- Webhook verification uses `constructEventAsync` (WebCrypto) — the sync
  `constructEvent` does not work on Workers.
- For production webhook dedupe, bind a KV namespace and use
  `dedupe: (c) => kvEventStore(c.env.STRIPE_EVENTS)`.

```toml
# wrangler.toml
compatibility_flags = ["nodejs_compat"]

[[kv_namespaces]]
binding = "STRIPE_EVENTS"
id = "..."
```

## Node

Everything works the same — keys resolve from `process.env`, and the SDK uses
its native HTTP client and crypto provider automatically.

## Production checklist

- **Decide amounts server-side** — never trust client-sent prices.
- **Enable dedupe** for webhook handlers with side effects (mail, provisioning,
  billing state).
- **Stable idempotency keys** for client-visible operations: pass
  `{ idempotencyKey }` derived from your cart/order id to
  `stripe.paymentIntents.create` / `stripe.checkout.sessions.create` so
  double-submits collapse into one Stripe object.
- **Let handler errors return 500** — Stripe retries are the recovery path.
- **Install `app.onError(stripeErrorHandler())`** — a `StripeCardError` should
  reach your user as a 402, not a 500, and Stripe auth problems should never
  leak their raw messages to clients.
