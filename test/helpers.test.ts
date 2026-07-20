import { Hono } from 'hono'
import type Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'
import { createCheckoutSession, createPaymentIntent } from '../src/helpers'
import { getStripe } from '../src/context'
import type { StripeEnv } from '../src/types'

/** Build an app whose context carries a fake Stripe client. */
const buildApp = (fakeStripe: unknown) => {
  const app = new Hono<StripeEnv>()
  app.use(async (c, next) => {
    c.set('stripe', fakeStripe as Stripe)
    await next()
  })
  return app
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('createPaymentIntent', () => {
  it('forwards params to stripe.paymentIntents.create and returns the intent', async () => {
    const create = vi.fn().mockResolvedValue({ client_secret: 'pi_secret' })
    const app = buildApp({ paymentIntents: { create } })
    app.post('/', async (c) => {
      const intent = await createPaymentIntent(c, { amount: 1400, currency: 'usd' })
      return c.json({ clientSecret: intent.client_secret })
    })

    const res = await app.request('/', { method: 'POST' })
    expect(await res.json()).toEqual({ clientSecret: 'pi_secret' })
    const [params, options] = create.mock.calls[0]!
    expect(params).toEqual({ amount: 1400, currency: 'usd' })
    expect(options.idempotencyKey).toEqual(expect.any(String))
    expect(options.idempotencyKey.length).toBeGreaterThan(0)
  })

  it('auto-generates a UUID-shaped idempotencyKey when no options are supplied', async () => {
    const create = vi.fn().mockResolvedValue({ client_secret: 'pi_secret' })
    const app = buildApp({ paymentIntents: { create } })
    app.post('/', async (c) => {
      const intent = await createPaymentIntent(c, { amount: 1400, currency: 'usd' })
      return c.json({ clientSecret: intent.client_secret })
    })

    await app.request('/', { method: 'POST' })
    const [, options] = create.mock.calls[0]!
    expect(options.idempotencyKey).toMatch(UUID_RE)
  })

  it('preserves a caller-supplied idempotencyKey', async () => {
    const create = vi.fn().mockResolvedValue({ client_secret: 'pi_secret' })
    const app = buildApp({ paymentIntents: { create } })
    app.post('/', async (c) => {
      const intent = await createPaymentIntent(
        c,
        { amount: 1400, currency: 'usd' },
        { idempotencyKey: 'my-stable-key' },
      )
      return c.json({ clientSecret: intent.client_secret })
    })

    await app.request('/', { method: 'POST' })
    const [, options] = create.mock.calls[0]!
    expect(options.idempotencyKey).toBe('my-stable-key')
  })

  it('does not mutate the caller-supplied options object', async () => {
    const create = vi.fn().mockResolvedValue({ client_secret: 'pi_secret' })
    const app = buildApp({ paymentIntents: { create } })
    const originalOptions: Stripe.RequestOptions = {}
    app.post('/', async (c) => {
      const intent = await createPaymentIntent(c, { amount: 1400, currency: 'usd' }, originalOptions)
      return c.json({ clientSecret: intent.client_secret })
    })

    await app.request('/', { method: 'POST' })
    expect(originalOptions.idempotencyKey).toBeUndefined()
    const [, options] = create.mock.calls[0]!
    expect(options).not.toBe(originalOptions)
    expect(options.idempotencyKey).toMatch(UUID_RE)
  })
})

describe('createCheckoutSession', () => {
  it('forwards params verbatim to stripe.checkout.sessions.create', async () => {
    const create = vi.fn().mockResolvedValue({ client_secret: 'cs_secret' })
    const app = buildApp({ checkout: { sessions: { create } } })
    app.post('/', async (c) => {
      const session = await createCheckoutSession(c, { ui_mode: 'embedded_page', mode: 'payment' })
      return c.json({ clientSecret: session.client_secret })
    })

    const res = await app.request('/', { method: 'POST' })
    expect(await res.json()).toEqual({ clientSecret: 'cs_secret' })
    const [params, options] = create.mock.calls[0]!
    expect(params).toEqual({ ui_mode: 'embedded_page', mode: 'payment' })
    expect(options.idempotencyKey).toEqual(expect.any(String))
    expect(options.idempotencyKey.length).toBeGreaterThan(0)
  })

  it('auto-generates a UUID-shaped idempotencyKey when no options are supplied', async () => {
    const create = vi.fn().mockResolvedValue({ client_secret: 'cs_secret' })
    const app = buildApp({ checkout: { sessions: { create } } })
    app.post('/', async (c) => {
      const session = await createCheckoutSession(c, { ui_mode: 'embedded_page', mode: 'payment' })
      return c.json({ clientSecret: session.client_secret })
    })

    await app.request('/', { method: 'POST' })
    const [, options] = create.mock.calls[0]!
    expect(options.idempotencyKey).toMatch(UUID_RE)
  })

  it('preserves a caller-supplied idempotencyKey', async () => {
    const create = vi.fn().mockResolvedValue({ client_secret: 'cs_secret' })
    const app = buildApp({ checkout: { sessions: { create } } })
    app.post('/', async (c) => {
      const session = await createCheckoutSession(
        c,
        { ui_mode: 'embedded_page', mode: 'payment' },
        { idempotencyKey: 'my-stable-key' },
      )
      return c.json({ clientSecret: session.client_secret })
    })

    await app.request('/', { method: 'POST' })
    const [, options] = create.mock.calls[0]!
    expect(options.idempotencyKey).toBe('my-stable-key')
  })

  it('does not mutate the caller-supplied options object', async () => {
    const create = vi.fn().mockResolvedValue({ client_secret: 'cs_secret' })
    const app = buildApp({ checkout: { sessions: { create } } })
    const originalOptions: Stripe.RequestOptions = {}
    app.post('/', async (c) => {
      const session = await createCheckoutSession(
        c,
        { ui_mode: 'embedded_page', mode: 'payment' },
        originalOptions,
      )
      return c.json({ clientSecret: session.client_secret })
    })

    await app.request('/', { method: 'POST' })
    expect(originalOptions.idempotencyKey).toBeUndefined()
    const [, options] = create.mock.calls[0]!
    expect(options).not.toBe(originalOptions)
    expect(options.idempotencyKey).toMatch(UUID_RE)
  })
})

describe('getStripe', () => {
  it('throws when the middleware has not run', async () => {
    const app = new Hono<StripeEnv>()
    app.onError((err, c) => c.text(err.message, 500))
    app.get('/', (c) => {
      getStripe(c)
      return c.body(null, 200)
    })
    const res = await app.request('/')
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('Stripe client not found')
  })
})
