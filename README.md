# hono-stripe

> The all-in-one Stripe toolkit for [Hono](https://hono.dev) and HonoX — works on Cloudflare Workers and Node.

One install covers the whole server-side Stripe integration:

| Module | What you get |
| -- | -- |
| `hono-stripe` | Stripe client middleware (`c.var.stripe`), Stripe→HTTP error mapping for `app.onError` |
| `hono-stripe/webhook` | `stripeWebhook` — verify + **typed per-event routing** + delivery dedupe (`KV`, in-memory, or your own store) |
| `hono-stripe/testing` | Real-signature webhook fixtures for tests and local dev — no `stripe listen` required |
| `hono-stripe/ui` | hono/jsx (HonoX) components that render a working Payment Element form — no React |

It handles the edge-runtime gotchas for you (`createFetchHttpClient`, async
webhook verification via WebCrypto) and keeps `stripe`/`hono` as peer
dependencies — you bring your own versions.

> **Status:** early development (`0.x`). API may change between minor versions.

## Install

```sh
npm install hono-stripe stripe hono
```

## Quick start

### Cloudflare Workers

```ts
import { Hono } from 'hono'
import {
  stripeMiddleware,
  getStripe,
  stripeErrorHandler,
  type StripeEnv,
} from 'hono-stripe'
import { stripeWebhook, kvEventStore } from 'hono-stripe/webhook'

type Bindings = {
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  STRIPE_EVENTS: KVNamespace
}

const app = new Hono<{ Bindings: Bindings } & StripeEnv>()

// Stripe SDK errors → right HTTP statuses (card decline → 402, not 500).
app.onError(stripeErrorHandler())

// Reads STRIPE_SECRET_KEY from the Workers env binding.
// On Workers, Stripe.createFetchHttpClient() is applied automatically.
app.use(stripeMiddleware())

app.post('/api/payment-intent', async (c) => {
  // Decide the amount on the server (e.g. from a price id / cart lookup),
  // never trust an amount sent by the client.
  const intent = await getStripe(c).paymentIntents.create({ amount: 1400, currency: 'usd' })
  return c.json({ clientSecret: intent.client_secret })
})

// Verify + route + dedupe in one middleware. `event.data.object` is typed
// per event name — the stripe SDK discriminates events by `type`.
app.post(
  '/api/webhook',
  stripeWebhook({
    // c.env only exists at request time — resolve the store lazily per request.
    dedupe: (c) => kvEventStore(c.env.STRIPE_EVENTS),
    on: {
      'payment_intent.succeeded': (event) => {
        console.log('paid', event.data.object.id) // Stripe.PaymentIntent
      },
      'checkout.session.completed': async (event) => {
        await fulfillOrder(event.data.object)     // Stripe.Checkout.Session
      },
    },
  }),
)

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
import { stripeMiddleware, getStripe, type StripeEnv } from 'hono-stripe'

const app = new Hono<StripeEnv>()
app.use(stripeMiddleware()) // reads process.env.STRIPE_SECRET_KEY

app.post('/api/payment-intent', async (c) => {
  const intent = await getStripe(c).paymentIntents.create({ amount: 1400, currency: 'usd' })
  return c.json({ clientSecret: intent.client_secret })
})

serve(app)
```

## Webhooks — `hono-stripe/webhook`

`stripeWebhook` composes the three things every Stripe webhook endpoint needs:

1. **Verify** — `constructEventAsync` (async WebCrypto, Workers-safe). Missing
   or bad signatures get a `400`, not a `500`, so Stripe doesn't retry
   invalid requests.
2. **Route** — handlers keyed by event type, with `event.data.object` narrowed
   to the concrete resource type for every event type the SDK knows.
3. **Dedupe** — Stripe retries deliveries for up to ~3 days. Pass a store to
   acknowledge repeat deliveries without re-running the handler.

```ts
import { stripeWebhook, memoryEventStore, kvEventStore } from 'hono-stripe/webhook'

app.post('/webhook', stripeWebhook({
  // Secret resolution order: `secret` (string or (c) => string) →
  // env binding / process.env[webhookSecretVar] (default STRIPE_WEBHOOK_SECRET)
  secret: (c) => c.env.STRIPE_WEBHOOK_SECRET,

  // Or a plain store: memoryEventStore() for dev / single-isolate Node.
  dedupe: (c) => kvEventStore(c.env.STRIPE_EVENTS),

  on: {
    'customer.subscription.deleted': async (event, c) => {
      await downgrade(event.data.object.customer)
    },
  },

  // Optional: override the default 200 for verified-but-unhandled events.
  onUnhandled: (event, c) => c.json({ ignored: event.type }),
}))
```

The Stripe client for verification comes from `c.var.stripe` when
`stripeMiddleware()` has run; otherwise `stripeWebhook` builds one from
`apiKey` / `STRIPE_SECRET_KEY` (verification is local HMAC — no API call).

- A handler may `return c.json(...)` / `Response` (sent verbatim) or return
  nothing (`200 { received: true }`).
- A handler that throws surfaces as a `500` via Hono's error handling, so
  Stripe retries — and since dedupe records only on a 2xx-equivalent
  outcome (a throw **or a returned non-2xx `Response`** counts as failure),
  retries are processed normally.
- `verifyStripeSignature(c, { secret })` remains available from
  `hono-stripe/webhook` as the bare primitive if you want a `switch` instead
  of a router.

### `StripeEventStore`

Bring your own backend (D1, Upstash, DB) by implementing two methods:

```ts
interface StripeEventStore {
  has(eventId: string): Promise<boolean>
  put(eventId: string, ttlSeconds: number): Promise<void>
}
```

`memoryEventStore()` (in-process) and `kvEventStore(namespace)` (Workers KV,
auto-expiring keys) are provided. Default retention is 3 days.

## Testing — `hono-stripe/testing`

Webhook signatures are just HMAC-SHA256 over `${timestamp}.${payload}`. This
module produces **real** signatures with WebCrypto, so they verify against the
actual Stripe SDK on every runtime — run the full verify → route → dedupe path
in `vitest` without `stripe listen` or network access.

```ts
import { Hono } from 'hono'
import { stripeWebhook } from 'hono-stripe/webhook'
import { createTestEvent, createWebhookRequest } from 'hono-stripe/testing'

const app = new Hono().post('/webhook', stripeWebhook({
  apiKey: 'sk_test_x',
  secret: 'whsec_test',
  on: { 'payment_intent.succeeded': handler },
}))

const res = await app.request(await createWebhookRequest(
  createTestEvent('payment_intent.succeeded', { id: 'pi_1', amount: 1400 }),
  { secret: 'whsec_test' },
))
expect(res.status).toBe(200)
```

| Export | Purpose |
| -- | -- |
| `signStripePayload(payload, secret, timestamp?)` | `t=...,v1=...` header value; backdate `timestamp` to test tolerance handling |
| `createTestEvent(type, object, options?)` | `Stripe.Event`-shaped fixture around your `data.object` |
| `createWebhookRequest(event \| payload, { secret, url?, timestamp? })` | `Request` with a valid signature, ready for `app.request()` or `fetch` |

## Billing — `hono-stripe/billing`

Local subscription mirror + plan-gating, in the Cashier style: webhook
handlers keep `stripe_customers` / `stripe_subscriptions` rows in your own
database, and entitlement checks read from there instead of the Stripe API.
The sync protocol (fetch-on-event + timestamp-guarded write + refetch on
same-second ties) was model-checked for duplicate, out-of-order, and
concurrent deliveries — see `spec/`.

```ts
import { stripeBilling, sqlBillingStore } from 'hono-stripe/billing'
import { mergeWebhookHandlers, stripeWebhook } from 'hono-stripe/webhook'

const billing = stripeBilling({
  store: (c) =>
    sqlBillingStore((sql, params = []) =>
      c.env.DB.prepare(sql).bind(...params).all().then((r) => r.results),
    ), // D1, better-sqlite3, postgres.js, pg — any driver
  plans: { pro: 'price_pro_monthly', team: ['price_team_m', 'price_team_y'] },
  user: (c) => c.get('authUser').id,
})

app.post('/webhook', stripeWebhook({
  dedupe: (c) => kvEventStore(c.env.STRIPE_EVENTS),
  on: mergeWebhookHandlers(billing.handlers, {
    'checkout.session.completed': fulfill,
  }),
}))

app.get('/pro/data', billing.requirePlan(['pro', 'team']), (c) => c.text('ok'))
```

| Export | Purpose |
| -- | -- |
| `stripeBilling(options)` | Factory: `handlers`, `getState`, `requirePlan`, `middleware`, `checkoutParams`, `syncFromStripe` |
| `sqlBillingStore(execute, { dialect? })` | Production store — atomic guarded upsert (`sqlite` or `pg`) |
| `memoryBillingStore()` | Dev/tests |
| `BILLING_SCHEMA_SQLITE` / `BILLING_SCHEMA_PG` | DDL for `stripe_customers` + `stripe_subscriptions` (`hono-stripe/billing/schema`) |
| `billingSyncHandlers(opts)` | The sync handlers alone, for custom composition |

Link your app user to Stripe at checkout with `billing.checkoutParams(userId)`
(merge your own keys via the second argument — the linkage key always wins);
userId resolution order is `client_reference_id` → session metadata →
subscription metadata → customer metadata. Cloudflare Workers KV cannot be a
correctness-complete mirror (no atomic check-and-write) — use the SQL store as
source of truth and `syncFromStripe()` for reconciliation.

`requirePlan` gates on `state.entitledPlans` — the plans matched by **every**
entitled subscription, so a user paying for `pro` on an older subscription
isn't denied because a newer sub wins the deterministic "best" pick. When the
`user` resolver can't resolve a user (returns nullish or throws), entitlement
APIs respond `401`. Use `BillingEnv` to type `c.var.billing`.

## Payment UI — `hono-stripe/ui`

Server-render a working [stripe-pwa-elements](https://github.com/stripe/stripe-pwa-elements)
`<stripe-payment-element>` from hono/jsx or HonoX — no React, no frontend build
step. The component code loads from a CDN as an ES module.

```tsx
import { StripePaymentForm } from 'hono-stripe/ui'

app.get('/', (c) =>
  c.html(<StripePaymentForm
    endpoint="/api/payment-intent"   // POST → { clientSecret, publishableKey? }
    publishableKey={c.env.STRIPE_PUBLISHABLE_KEY}
  />)
)
```

Two modes:

- **`endpoint`**: the browser POSTs to your endpoint and assigns the returned
  `clientSecret` to the element (e.g. a PaymentIntent or Checkout Session
  created via `getStripe(c)` above).
- **`clientSecret`**: pass a secret created during SSR — rendered as an element
  attribute, no client-side fetch.

```tsx
app.get('/', async (c) => {
  const intent = await getStripe(c).paymentIntents.create({ amount: 1400, currency: 'usd' })
  return c.html(<StripePaymentForm
    clientSecret={intent.client_secret!}
    publishableKey={c.env.STRIPE_PUBLISHABLE_KEY}
  />)
})
```

`intent="checkout"` switches to Checkout Session mode
(`checkout-session-client-secret`). `StripeElementsScript` (the `<script
type="module">` loader) is rendered automatically; pass `src` to self-host
instead of using the CDN.

## API — `hono-stripe`

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

### `stripeErrorHandler(options?)`

A Hono `onError` handler that maps Stripe SDK errors to the right HTTP status
instead of letting every Stripe failure become a `500`:

```ts
import { stripeErrorHandler } from 'hono-stripe'

app.onError(stripeErrorHandler({ locale: 'ja' })) // 'en' default

// or per-request — e.g. follow Accept-Language:
app.onError(stripeErrorHandler({
  locale: (c) => c.req.header('accept-language')?.startsWith('ja') ? 'ja' : 'en',
}))
```

Card declines get extra fields your client can render directly —
`error.userMessage` is the localized "what to do next" text and
`error.retryable` distinguishes a soft decline (worth retrying, e.g.
`insufficient_funds`) from a hard one (`fraudulent`, `stolen_card`). Both come
from [stripe-decline-codes](https://github.com/hideokamoto/stripe-decline-codes).

| Stripe error | Status | Notes |
| -- | -- | -- |
| `StripeCardError` | 402 | `code` = decline_code, plus `userMessage` (localized via `stripe-decline-codes`) and `retryable` (soft-decline detection) |
| `StripeInvalidRequestError`, `TemporarySessionExpiredError` | 400 | |
| `StripeSignatureVerificationError` | 400 | details not leaked |
| `StripeIdempotencyError` | 409 | |
| `StripeRateLimitError` | 429 | |
| `StripeConnectionError`, `StripeAPIError` | 502 | upstream failure — safe to retry |
| `StripeAuthenticationError`, `StripePermissionError` | 500 | generic message — never leaks key details |
| Other `StripeError` with 4xx `statusCode` | that status | |
| Other `StripeError` | 502 | |
| `HTTPException` | untouched | pass-through |
| Anything else | 500 | or `options.fallback(err, c)` |

### `getStripe(c)`

Returns `c.var.stripe`, throwing a clear error if the middleware has not run.

### Runtime helpers

`isNodeRuntime()`, `isWorkersRuntime()`, `shouldUseFetchHttpClient()` are
exported for advanced/diagnostic use.

## Starter template

A runnable full-stack example (Hono + Cloudflare Workers + Payment Element UI,
with both PaymentIntent and Checkout Session flows) lives in
[`examples/cloudflare-workers`](./examples/cloudflare-workers). Clone, set your
test keys, `pnpm dev`.

## Documentation

The docs site lives in [`docs/`](./docs) (Starlight + TypeDoc, deployed to
Cloudflare Workers Static Assets). Run it locally with `pnpm -C docs dev`; see
[`docs/README.md`](./docs/README.md) for build/deploy details.

## Bundle size

Staying thin is a feature. CI enforces a
[size-limit](https://github.com/ai/size-limit) budget per entry point
(`.size-limit.json`) and posts the current sizes to each PR. `stripe`/`hono`
are peers and are never bundled. The browser-side payment components load from
a CDN, so they're not in your server bundle either.

```sh
pnpm run size
```

## License

MIT
