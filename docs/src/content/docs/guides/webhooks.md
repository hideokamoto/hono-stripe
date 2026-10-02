---
title: Webhooks
description: Signature verification, typed per-event routing, and delivery deduplication with stripeWebhook.
---

`stripeWebhook` composes the three things every Stripe webhook endpoint needs:

1. **Verify** — `constructEventAsync` (async WebCrypto, so it works on
   Cloudflare Workers). Missing or invalid signatures return `400`, not `500`,
   so Stripe doesn't retry unverifiable requests.
2. **Route** — handlers keyed by event type. `event.data.object` is narrowed
   to the concrete resource type (`Stripe.PaymentIntent`,
   `Stripe.Checkout.Session`, …) for every event type the installed SDK knows.
3. **Dedupe** — Stripe retries deliveries for up to ~3 days. A store records
   processed `event.id`s so repeats are acknowledged without re-running the
   handler.

```ts
import { stripeWebhook, memoryEventStore } from 'hono-stripe/webhook'

app.post('/webhook', stripeWebhook({
  // Secret resolution: `secret` (string or (c) => string) →
  // env binding / process.env[webhookSecretVar] (default STRIPE_WEBHOOK_SECRET)
  secret: (c) => c.env.STRIPE_WEBHOOK_SECRET,

  dedupe: memoryEventStore(),

  on: {
    'payment_intent.succeeded': (event) => {
      console.log(event.data.object.amount) // typed Stripe.PaymentIntent
    },
    'customer.subscription.deleted': async (event) => {
      await downgrade(event.data.object.customer) // typed Stripe.Subscription
    },
  },

  // Verified events with no handler → default 200 { received: true }.
  onUnhandled: (event, c) => c.json({ ignored: event.type }),
}))
```

## Handler contract

- Return a `Response` (`c.json(...)`, `c.text(...)`, …) to control the reply,
  or nothing for the default `200 { received: true }`.
- Throwing surfaces as a `500` via Hono error handling → Stripe retries. Since
  dedupe records only **after** a successful handler, retried deliveries are
  processed normally.

## Deduplication stores

```ts
interface StripeEventStore {
  has(eventId: string): Promise<boolean>
  put(eventId: string, ttlSeconds: number): Promise<void>
}
```

| Store | Use for |
| -- | -- |
| `memoryEventStore()` | Dev, tests, single-process Node |
| `kvEventStore(namespace)` | Cloudflare Workers KV (auto-expiring keys) |
| Your own | D1, DynamoDB, Upstash, Postgres… implement the two methods |

On Workers, env bindings only exist at request time — pass a factory:

```ts
stripeWebhook({
  dedupe: (c) => kvEventStore(c.env.STRIPE_EVENTS),
  // ...
})
```

Default retention is 3 days (`dedupeTtlSeconds`), matching Stripe's retry
window.

### Custom store examples

The interface is deliberately minimal — two async methods — so any storage
works.

**DynamoDB** (TTL attribute handles expiry):

```ts
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb'
import type { StripeEventStore } from 'hono-stripe/webhook'

const dynamoEventStore = (client: DynamoDBClient, table: string): StripeEventStore => ({
  has: async (eventId) => {
    const res = await client.send(new GetItemCommand({
      TableName: table,
      Key: { id: { S: `stripe:evt:${eventId}` } },
    }))
    return res.Item !== undefined
  },
  put: async (eventId, ttlSeconds) => {
    await client.send(new PutItemCommand({
      TableName: table,
      Item: {
        id: { S: `stripe:evt:${eventId}` },
        ttl: { N: String(Math.floor(Date.now() / 1000) + ttlSeconds) },
      },
    }))
  },
})
```

**D1** (Cloudflare's SQLite — expiry checked at read time):

```ts
const d1EventStore = (db: D1Database): StripeEventStore => ({
  // CREATE TABLE stripe_events (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)
  has: async (eventId) =>
    (await db
      .prepare('SELECT 1 FROM stripe_events WHERE id = ? AND expires_at > unixepoch()')
      .bind(`stripe:evt:${eventId}`)
      .first()) !== null,
  put: async (eventId, ttlSeconds) => {
    await db
      .prepare('INSERT OR IGNORE INTO stripe_events (id, expires_at) VALUES (?, unixepoch() + ?)')
      .bind(`stripe:evt:${eventId}`, ttlSeconds)
      .run()
  },
})

stripeWebhook({
  dedupe: (c) => d1EventStore(c.env.DB),
  // ...
})
```

## Standalone use without `stripeMiddleware`

Verification is local HMAC — no Stripe API call. When `c.var.stripe` is unset,
`stripeWebhook` builds a verification client from `apiKey` or
`STRIPE_SECRET_KEY` (`apiKeyVar` overrides the name), so the middleware works
standalone.

## The bare primitive

Prefer a `switch`? `verifyStripeSignature` stays available:

```ts
import { verifyStripeSignature } from 'hono-stripe/webhook'
// (also exported from 'hono-stripe')

app.post('/webhook', async (c) => {
  const event = await verifyStripeSignature(c, { secret: c.env.STRIPE_WEBHOOK_SECRET })
  switch (event.type) { /* ... */ }
  return c.body(null, 200)
})
```
