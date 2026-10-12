---
title: Testing
description: Signed Stripe webhook fixtures — no stripe listen, no network, works on every runtime.
---

Stripe webhook signatures are HMAC-SHA256 over `${timestamp}.${payload}`.
`hono-stripe/testing` generates **real** signatures with WebCrypto
(`crypto.subtle`), so the fixtures verify against the actual Stripe SDK on
Node, Workers, Deno, and Bun — no `stripe listen`, no network, no Stripe
account needed.

## End-to-end in vitest

```ts
import { Hono } from 'hono'
import { stripeWebhook } from 'hono-stripe/webhook'
import { createTestEvent, createWebhookRequest } from 'hono-stripe/testing'

const SECRET = 'whsec_test'

const handler = vi.fn()
const app = new Hono().post(
  '/webhook',
  stripeWebhook({
    apiKey: 'sk_test_x', // builds a local verification client — no API calls
    secret: SECRET,
    on: { 'payment_intent.succeeded': handler },
  }),
)

it('processes a payment_intent.succeeded event', async () => {
  const req = await createWebhookRequest(
    createTestEvent('payment_intent.succeeded', { id: 'pi_1', amount: 1400 }),
    { secret: SECRET },
  )
  const res = await app.request(req)

  expect(res.status).toBe(200)
  expect(handler).toHaveBeenCalledTimes(1)
})
```

The signature is genuinely verified — a tampered payload or wrong secret fails
exactly like a forged request would in production.

## Fixtures

### `createTestEvent(type, object, options?)`

Builds a `Stripe.Event`-shaped object around your `data.object`:

```ts
createTestEvent('checkout.session.completed', {
  id: 'cs_1',
  customer: 'cus_1',
}, {
  id: 'evt_fixed',        // deterministic event id (for dedupe tests)
  livemode: false,
})
```

### `createWebhookRequest(event | payload, options)`

Wraps a fixture (or raw payload string) in a signed `Request`:

```ts
await createWebhookRequest(event, {
  secret: 'whsec_test',
  url: 'http://localhost/webhook', // default
  timestamp,                       // override to test tolerance rejection
  headers,                         // extra request headers
})
```

### `signStripePayload(payload, secret, timestamp?)`

Just the `t=...,v1=...` header value, if you want to assemble requests
yourself.

## Negative tests

```ts
// Expired timestamp → verification fails inside the tolerance window
const stale = await signStripePayload(payload, SECRET, Date.now() / 1000 - 3600)
```
