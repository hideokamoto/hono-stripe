import { Hono } from 'hono'
import type Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryEventStore } from '../src/dedupe'
import { __resetCaches } from '../src/runtime'
import { createTestEvent, createWebhookRequest } from '../src/testing'
import type { StripeEnv } from '../src/types'
import { mergeWebhookHandlers, stripeWebhook } from '../src/webhooks'

const WEBHOOK_SECRET = 'whsec_test_signing_secret'
const API_KEY = 'sk_test_123'

beforeEach(() => __resetCaches())
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.STRIPE_WEBHOOK_SECRET
})

// Requests carry real Stripe signatures (created via hono-stripe/testing), and
// verification runs through the real stripe SDK — constructEventAsync performs
// HMAC checks locally, so no network access is needed. { apiKey } lets the
// middleware build its own verification client without stripeMiddleware().
const buildApp = (options: Omit<Parameters<typeof stripeWebhook>[0], 'on'> & {
  on?: Parameters<typeof stripeWebhook>[0]['on']
}) =>
  new Hono().post(
    '/webhook',
    stripeWebhook({ apiKey: API_KEY, secret: WEBHOOK_SECRET, on: {}, ...options }),
  )

const postEvent = async (app: Hono, type: string, object: object, id?: string) =>
  app.request(
    await createWebhookRequest(
      createTestEvent(type as Parameters<typeof createTestEvent>[0], object, id ? { id } : {}),
      { secret: WEBHOOK_SECRET, url: 'http://localhost/webhook' },
    ),
  )

describe('stripeWebhook', () => {
  it('verifies the signature and dispatches to the typed handler', async () => {
    const handler = vi.fn()
    const app = buildApp({ on: { 'payment_intent.succeeded': handler } })

    const res = await postEvent(app, 'payment_intent.succeeded', { id: 'pi_1', amount: 1400 })

    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
    const [event] = handler.mock.calls[0]!
    expect(event.type).toBe('payment_intent.succeeded')
    expect(event.data.object).toMatchObject({ id: 'pi_1', amount: 1400 })
  })

  it('returns 200 {"received":true} for verified events with no handler', async () => {
    const app = buildApp({})
    const res = await postEvent(app, 'customer.updated', { id: 'cus_1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true })
  })

  it('uses the Response returned by a handler verbatim', async () => {
    const app = buildApp({
      on: {
        'checkout.session.completed': (_event, c) => c.json({ ok: true }, 201),
      },
    })
    const res = await postEvent(app, 'checkout.session.completed', { id: 'cs_1' })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('calls onUnhandled for verified events without a matching handler', async () => {
    const onUnhandled = vi.fn((_event, c) => c.json({ ignored: true }, 202))
    const app = buildApp({ onUnhandled })
    const res = await postEvent(app, 'payout.paid', { id: 'po_1' })
    expect(res.status).toBe(202)
    expect(onUnhandled).toHaveBeenCalledTimes(1)
  })

  it('responds 400 on an invalid signature', async () => {
    const handler = vi.fn()
    const app = buildApp({ on: { 'payment_intent.succeeded': handler } })

    const res = await app.request('/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=bad' },
      body: '{}',
    })

    expect(res.status).toBe(400)
    expect(handler).not.toHaveBeenCalled()
  })

  it('dedupes repeat deliveries of the same event id', async () => {
    const handler = vi.fn()
    const app = buildApp({
      dedupe: memoryEventStore(),
      on: { 'payment_intent.succeeded': handler },
    })

    const first = await postEvent(app, 'payment_intent.succeeded', { id: 'pi_1' }, 'evt_dup')
    const second = await postEvent(app, 'payment_intent.succeeded', { id: 'pi_1' }, 'evt_dup')

    expect(await first.json()).toEqual({ received: true })
    expect(await second.json()).toEqual({ received: true, duplicate: true })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('accepts dedupe as a per-request function (Workers env bindings)', async () => {
    const handler = vi.fn()
    const store = memoryEventStore()
    const app = buildApp({
      dedupe: () => store,
      on: { 'payment_intent.succeeded': handler },
    })

    await postEvent(app, 'payment_intent.succeeded', { id: 'pi_1' }, 'evt_fn')
    const dup = await postEvent(app, 'payment_intent.succeeded', { id: 'pi_1' }, 'evt_fn')
    expect(await dup.json()).toEqual({ received: true, duplicate: true })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('retries normally when the handler throws (no dedupe record)', async () => {
    const handler = vi.fn((): void => {
      throw new Error('boom')
    })
    const app = buildApp({
      dedupe: memoryEventStore(),
      on: { 'payment_intent.succeeded': handler },
    })
    app.onError((err, c) => c.text(err.message, 500))

    const res = await postEvent(app, 'payment_intent.succeeded', { id: 'pi_1' }, 'evt_fail')
    expect(res.status).toBe(500)

    // A retried delivery must NOT be treated as a duplicate.
    handler.mockImplementationOnce(() => {})
    const retry = await postEvent(app, 'payment_intent.succeeded', { id: 'pi_1' }, 'evt_fail')
    expect(retry.status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('reads the webhook secret from process.env when secret is omitted', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
    const handler = vi.fn()
    const app = new Hono().post(
      '/webhook',
      stripeWebhook({ apiKey: API_KEY, on: { 'payment_intent.succeeded': handler } }),
    )
    const res = await postEvent(app, 'payment_intent.succeeded', { id: 'pi_1' })
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('supports a secret function for per-request secrets', async () => {
    const handler = vi.fn()
    const app = new Hono().post(
      '/webhook',
      stripeWebhook({
        apiKey: API_KEY,
        secret: () => WEBHOOK_SECRET,
        on: { 'payment_intent.succeeded': handler },
      }),
    )
    const res = await postEvent(app, 'payment_intent.succeeded', { id: 'pi_1' })
    expect(res.status).toBe(200)
  })

  it('uses c.var.stripe when stripeMiddleware has run', async () => {
    const constructEventAsync = vi.fn().mockResolvedValue({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_1' } },
    })
    const handler = vi.fn()
    const app = new Hono<StripeEnv>()
    app.use('/webhook', async (c, next) => {
      c.set('stripe', { webhooks: { constructEventAsync } } as unknown as Stripe)
      await next()
    })
    app.post('/webhook', stripeWebhook({ secret: WEBHOOK_SECRET, on: { 'payment_intent.succeeded': handler } }))

    const res = await app.request('/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig' },
      body: '{}',
    })
    expect(res.status).toBe(200)
    expect(constructEventAsync).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('mergeWebhookHandlers', () => {
  it('runs handlers for the same event key in order and uses the first response', async () => {
    const order: string[] = []
    const merged = mergeWebhookHandlers(
      { 'payment_intent.succeeded': async () => { order.push('a') } },
      { 'payment_intent.succeeded': async () => { order.push('b'); return new Response('custom') } },
    )
    const app = buildApp({ on: merged })
    const res = await postEvent(app, 'payment_intent.succeeded', { id: 'pi_1' })
    expect(order).toEqual(['a', 'b'])
    expect(await res.text()).toBe('custom')
  })

  it('keeps distinct event keys from each map', async () => {
    const seen: string[] = []
    const merged = mergeWebhookHandlers(
      { 'payment_intent.succeeded': () => { seen.push('pi') } },
      { 'customer.updated': () => { seen.push('cus') } },
    )
    const app = buildApp({ on: merged })
    await postEvent(app, 'customer.updated', { id: 'cus_1' })
    await postEvent(app, 'payment_intent.succeeded', { id: 'pi_1' })
    expect(seen).toEqual(['cus', 'pi'])
  })
})
