---
title: Getting Started
description: Install hono-stripe and wire up a Stripe client, payment endpoint, and webhook in a few minutes.
---

`hono-stripe` is the all-in-one Stripe toolkit for [Hono](https://hono.dev) and
HonoX. It runs on Cloudflare Workers, Node, and every other runtime Hono
supports.

## Install

```sh
npm install hono-stripe stripe hono
```

`stripe` (`>=17`) and `hono` (`>=4`) are peer dependencies — you bring your own
versions.

## The four modules

| Import | Purpose |
| -- | -- |
| `hono-stripe` | Client middleware + PaymentIntent / Checkout Session helpers |
| `hono-stripe/webhook` | `stripeWebhook` — verify, typed routing, delivery dedupe |
| `hono-stripe/testing` | Signed webhook fixtures for tests and local dev |
| `hono-stripe/ui` | hono/jsx components that render a Payment Element form |

## Minimal app

```ts
import { Hono } from 'hono'
import { stripeMiddleware, createPaymentIntent, type StripeEnv } from 'hono-stripe'
import { stripeWebhook } from 'hono-stripe/webhook'

const app = new Hono<StripeEnv>()

// Reads STRIPE_SECRET_KEY from the env binding / process.env.
// On Workers, Stripe.createFetchHttpClient() is applied automatically.
app.use(stripeMiddleware())

app.post('/api/payment-intent', async (c) => {
  // Decide the amount on the server — never trust the client.
  const intent = await createPaymentIntent(c, { amount: 1400, currency: 'usd' })
  return c.json({ clientSecret: intent.client_secret })
})

app.post(
  '/api/webhook',
  stripeWebhook({
    on: {
      'payment_intent.succeeded': (event) => {
        // event.data.object is typed as Stripe.PaymentIntent
        console.log('paid', event.data.object.id)
      },
    },
  }),
)

export default app
```

Set `STRIPE_SECRET_KEY` (and `STRIPE_WEBHOOK_SECRET` for webhooks) as an env
binding on Workers or `process.env` on Node — or pass `apiKey`/`secret`
explicitly.

## Key resolution order

| Option | Where it reads | Default key name |
| -- | -- | -- |
| `stripeMiddleware` API key | `apiKey` → env binding → `process.env` | `STRIPE_SECRET_KEY` |
| `stripeWebhook` signing secret | `secret` → env binding → `process.env` | `STRIPE_WEBHOOK_SECRET` |

## Runnable example

A full-stack starter (Payment Element UI + PaymentIntent + Checkout Session +
webhook) lives in
[`examples/cloudflare-workers`](https://github.com/hideokamoto/hono-stripe/tree/main/examples/cloudflare-workers).
