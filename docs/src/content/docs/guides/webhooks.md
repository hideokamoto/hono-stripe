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
  the dedupe claim is released when the handler throws (or returns a non-2xx
  `Response`), retried deliveries are processed normally.

## Deduplication stores

```ts
interface StripeEventStore {
  claim(eventId: string, ttlSeconds: number): Promise<boolean> // atomic
  release(eventId: string): Promise<void>
}
```

`claim` runs **before** the handler and must be atomic: of concurrent
deliveries of the same event, exactly one gets `true`. The others are
acknowledged as `duplicate` without running the handler. If the handler throws
or returns a non-2xx response, the router calls `release` so Stripe's retry can
claim it again.

:::caution
Workers KV is eventually consistent and has no conditional write, so it cannot
implement `claim` — two locations can both see "not claimed". Use a store with
atomic writes (D1, a Durable Object, Postgres, DynamoDB conditional writes,
Redis `SET NX`). If a process crashes mid-handler the claim stays until
`dedupeTtlSeconds` expires; keep handlers idempotent as a second line of
defense.
:::

| Store | Use for |
| -- | -- |
| `memoryEventStore()` | Dev, tests, single-process Node |
| Your own | D1, Durable Objects, DynamoDB, Postgres, Redis… implement the two methods atomically |

On Workers, env bindings only exist at request time — pass a factory:

```ts
stripeWebhook({
  dedupe: (c) => d1EventStore(c.env.DB), // defined below
  // ...
})
```

Default retention is 3 days (`dedupeTtlSeconds`), matching Stripe's retry
window.

### Custom store examples

The interface is deliberately minimal — two async methods — so any storage
with an atomic conditional write works.

**DynamoDB** (conditional put is atomic; TTL attribute handles cleanup):

```ts
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb'
import type { StripeEventStore } from 'hono-stripe/webhook'

const dynamoEventStore = (client: DynamoDBClient, table: string): StripeEventStore => ({
  claim: async (eventId, ttlSeconds) => {
    const now = Math.floor(Date.now() / 1000)
    try {
      await client.send(new PutItemCommand({
        TableName: table,
        Item: {
          id: { S: `stripe:evt:${eventId}` },
          ttl: { N: String(now + ttlSeconds) },
        },
        // Succeeds only if absent (or an expired item TTL has not swept yet).
        ConditionExpression: 'attribute_not_exists(id) OR #ttl < :now',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':now': { N: String(now) } },
      }))
      return true
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false
      throw err
    }
  },
  release: async (eventId) => {
    await client.send(new DeleteItemCommand({
      TableName: table,
      Key: { id: { S: `stripe:evt:${eventId}` } },
    }))
  },
})
```

**D1** (Cloudflare's SQLite — a single-statement upsert is atomic):

```ts
const d1EventStore = (db: D1Database): StripeEventStore => ({
  // CREATE TABLE stripe_events (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)
  claim: async (eventId, ttlSeconds) => {
    // Inserts a new row, or takes over an expired one; a live row is untouched.
    const res = await db
      .prepare(
        `INSERT INTO stripe_events (id, expires_at) VALUES (?, unixepoch() + ?)
         ON CONFLICT(id) DO UPDATE SET expires_at = excluded.expires_at
         WHERE stripe_events.expires_at <= unixepoch()`,
      )
      .bind(`stripe:evt:${eventId}`, ttlSeconds)
      .run()
    return res.meta.changes > 0
  },
  release: async (eventId) => {
    await db.prepare('DELETE FROM stripe_events WHERE id = ?').bind(`stripe:evt:${eventId}`).run()
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
