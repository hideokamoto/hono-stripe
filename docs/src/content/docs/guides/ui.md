---
title: Payment UI
description: Render a working Stripe Payment Element from hono/jsx or HonoX — no React, no frontend build.
---

`hono-stripe/ui` renders the
[stripe-pwa-elements](https://github.com/stripe/stripe-pwa-elements)
`<stripe-payment-element>` web component. The component code loads from a CDN
as an ES module — nothing is bundled into your Worker, and no React or
frontend build step is required.

## Endpoint mode

The browser POSTs to your endpoint for a `client_secret`:

```tsx
import { StripePaymentForm } from 'hono-stripe/ui'

app.get('/', (c) =>
  c.html(
    <StripePaymentForm
      endpoint="/api/payment-intent"
      publishableKey={c.env.STRIPE_PUBLISHABLE_KEY}
    />,
  ),
)

// POST /api/payment-intent must return { clientSecret, publishableKey? }
app.post('/api/payment-intent', async (c) => {
  const intent = await createPaymentIntent(c, { amount: 1400, currency: 'usd' })
  return c.json({ clientSecret: intent.client_secret })
})
```

## SSR mode

Create the secret in the same request and skip the client fetch entirely:

```tsx
app.get('/', async (c) => {
  const intent = await createPaymentIntent(c, { amount: 1400, currency: 'usd' })
  return c.html(
    <StripePaymentForm
      clientSecret={intent.client_secret!}
      publishableKey={c.env.STRIPE_PUBLISHABLE_KEY}
    />,
  )
})
```

## Checkout Session mode

```tsx
<StripePaymentForm endpoint="/api/checkout-session" intent="checkout" />
```

Uses `checkout-session-client-secret` — pair with `createCheckoutSession(c, {
ui_mode: 'embedded_page', /* or 'custom' on recent SDKs */ ... })`.

## Props

| Prop | Type | Notes |
| -- | -- | -- |
| `endpoint` | `string` | POST → `{ clientSecret, publishableKey? }`. Required unless `clientSecret` set |
| `clientSecret` | `string` | SSR mode — rendered as an element attribute |
| `publishableKey` | `string` | `pk_...`; in endpoint mode it's a fallback for the response |
| `intent` | `'payment' \| 'checkout'` | Default `'payment'` |
| `id` | `string` | Default `hono-stripe-payment` |
| `class` | `string` | Class on `<stripe-payment-element>` |
| `src` | `string` | Override the elements CDN module URL (self-hosting) |

Importing `hono-stripe/ui` also registers the `<stripe-payment-element>` type
with hono/jsx, so the raw tag type-checks too.

`StripeElementsScript` renders just the `<script type="module">` loader if you
need finer control.
