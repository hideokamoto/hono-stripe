# hono-stripe

> Stripe middleware and helpers for [Hono](https://hono.dev) — works on Cloudflare Workers and Node.

`hono-stripe` injects a configured Stripe client into your Hono context and gives
you thin helpers for the two things a payment backend needs first: creating a
**PaymentIntent / Checkout Session** (to hand a `client_secret` to the frontend)
and **verifying webhook signatures**. It handles the edge-runtime gotchas
(`createFetchHttpClient`, async webhook verification) for you.

> **Status:** early development (`0.0.1`). The goal is to upstream this as
> `@hono/stripe` to [honojs/middleware](https://github.com/honojs/middleware)
> once it has proven itself — see [Upstream plan](#upstream-plan). The current
> maintainer intends to keep maintaining it through and after that move.

## Where it fits — the 3 layers

A full Hono + Stripe stack is three small pieces, each owning one job:

| Layer | Package | Responsibility |
| -- | -- | -- |
| **Backend — client + intent/session** | **`hono-stripe`** (this) | Inject `c.var.stripe`; create PaymentIntents / Checkout Sessions; verify webhook signatures |
| Backend — webhook routing | [`@kotodayori/hono`](https://www.npmjs.com/package/@kotodayori/hono) | Typed, per-event webhook routing on top of a verified event |
| Frontend — payment UI | [stripe-pwa-elements](https://github.com/stripe/stripe-pwa-elements) | `<stripe-payment-element>` web components (no React required) |

`hono-stripe` deliberately stops at **verifying** the webhook. Event dispatch /
typed routing is the job of `@kotodayori/hono` — reach for it when you outgrow
the primitive here.

## Install

```sh
npm install hono-stripe stripe hono
```

`stripe` and `hono` are peer dependencies — you bring your own versions.

## Quick start

### Cloudflare Workers

```ts
import { Hono } from 'hono'
import {
  stripeMiddleware,
  createPaymentIntent,
  verifyStripeSignature,
  type StripeEnv,
} from 'hono-stripe'

type Bindings = { STRIPE_SECRET_KEY: string; STRIPE_WEBHOOK_SECRET: string }

const app = new Hono<{ Bindings: Bindings } & StripeEnv>()

// Reads STRIPE_SECRET_KEY from the Workers env binding.
// On Workers, Stripe.createFetchHttpClient() is applied automatically.
app.use(stripeMiddleware())

app.post('/api/payment-intent', async (c) => {
  // Decide the amount on the server (e.g. from a price id / cart lookup),
  // never trust an amount sent by the client.
  const intent = await createPaymentIntent(c, { amount: 1400, currency: 'usd' })
  return c.json({ clientSecret: intent.client_secret })
})

app.post('/api/webhook', async (c) => {
  const event = await verifyStripeSignature(c, { secret: c.env.STRIPE_WEBHOOK_SECRET })
  // Hand `event` to @kotodayori/hono for typed routing, or switch on event.type.
  return c.body(null, 200)
})

export default app
```

`.dev.vars` (Workers local dev — **test keys only**, never commit real keys):

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

### Node

```ts
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { stripeMiddleware, createPaymentIntent, type StripeEnv } from 'hono-stripe'

const app = new Hono<StripeEnv>()
app.use(stripeMiddleware()) // reads process.env.STRIPE_SECRET_KEY

app.post('/api/payment-intent', async (c) => {
  const intent = await createPaymentIntent(c, { amount: 1400, currency: 'usd' })
  return c.json({ clientSecret: intent.client_secret })
})

serve(app)
```

## API

### `stripeMiddleware(options?)`

Initializes a Stripe client and sets it at `c.var.stripe`. The secret key is
resolved in order:

1. `options.apiKey` (explicit)
2. Workers env binding `c.env[secretKeyVar]`
3. `process.env[secretKeyVar]`

`secretKeyVar` defaults to `STRIPE_SECRET_KEY`. On non-Node runtimes the SDK is
initialized with `Stripe.createFetchHttpClient()`. Clients are cached per key.

| Option | Type | Description |
| -- | -- | -- |
| `apiKey` | `string` | Secret key passed directly |
| `secretKeyVar` | `string` | Env / `process.env` key name (default `STRIPE_SECRET_KEY`) |
| `apiVersion` | `string` | Stripe API version override |
| `config` | `Stripe.StripeConfig` | Extra config; an explicit `httpClient` here wins |

### `createPaymentIntent(c, params, options?)` / `createCheckoutSession(c, params, options?)`

Thin wrappers over `stripe.paymentIntents.create` /
`stripe.checkout.sessions.create` that forward params verbatim. To drive the
frontend with a `client_secret` (the Checkout Sessions mode used by
stripe-pwa-elements), pass the client-side `ui_mode` for your Stripe version
(`'custom'` on recent Stripe, `'elements'` on older SDKs).

### `verifyStripeSignature(c, { secret, signatureHeader?, tolerance? })`

Reads the raw body and verifies it with `constructEventAsync` (the async form
required where WebCrypto is async, e.g. Workers), returning the verified
`Stripe.Event`. Throws if the signature header is missing or invalid.

### `getStripe(c)`

Returns `c.var.stripe`, throwing a clear error if the middleware has not run.

### Runtime helpers

`isNodeRuntime()`, `isWorkersRuntime()`, `shouldUseFetchHttpClient()` are
exported for advanced/diagnostic use.

## Bundle size

Staying thin is a feature. CI enforces a [size-limit](https://github.com/ai/size-limit)
budget on the built artifacts (`.size-limit.json`) and posts the current sizes
to each PR, so accidental bloat fails the build instead of slipping in. Run it
locally with:

```sh
pnpm run size
```

The library itself adds ~1 kB (brotli) per format; `stripe`/`hono` are peers and
are not bundled.

## Upstream plan

`hono-stripe` is built to be proposed to
[honojs/middleware](https://github.com/honojs/middleware) as `@hono/stripe`.
To keep that path open it depends on **`stripe` and `hono` as peers only** — no
other runtime dependencies. If the proposal is accepted, `hono-stripe` will be
deprecated with a pointer to `@hono/stripe`.

## License

MIT
