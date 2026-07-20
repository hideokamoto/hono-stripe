import { Hono } from 'hono'
import type Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetCaches } from '../src/runtime'
import { verifyStripeSignature } from '../src/webhook'
import type { StripeEnv } from '../src/types'

const SECRET = 'whsec_test'

// hono/adapter's getRuntimeKey() inspects navigator.userAgent to detect the
// runtime; faking it lets us exercise the real Workers crypto-provider path.
const asWorkers = () => vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' })

beforeEach(() => __resetCaches())
afterEach(() => vi.unstubAllGlobals())

const buildApp = (constructEventAsync: ReturnType<typeof vi.fn>) => {
  const app = new Hono<StripeEnv>()
  // No onError override: let Hono handle thrown HTTPExceptions natively so the
  // 400 status from verifyStripeSignature surfaces.
  app.use(async (c, next) => {
    c.set('stripe', { webhooks: { constructEventAsync } } as unknown as Stripe)
    await next()
  })
  return app
}

describe('verifyStripeSignature', () => {
  it('verifies the signature via constructEventAsync and returns the event', async () => {
    const event = { id: 'evt_1', type: 'payment_intent.succeeded' }
    const constructEventAsync = vi.fn().mockResolvedValue(event)
    const app = buildApp(constructEventAsync)
    app.post('/webhook', async (c) => {
      const e = await verifyStripeSignature(c, { secret: SECRET })
      return c.json({ type: e.type })
    })

    const res = await app.request('/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_abc' },
      body: '{"hello":"world"}',
    })

    expect(await res.json()).toEqual({ type: 'payment_intent.succeeded' })
    expect(constructEventAsync).toHaveBeenCalledTimes(1)
    const [payload, signature, secret, tolerance, provider] = constructEventAsync.mock.calls[0]!
    expect(payload).toBe('{"hello":"world"}')
    expect(signature).toBe('sig_abc')
    expect(secret).toBe(SECRET)
    expect(tolerance).toBeUndefined()
    // On Node, we omit the crypto provider so stripe-node auto-selects its Node
    // provider; injecting SubtleCrypto here would needlessly require crypto.subtle.
    expect(provider).toBeUndefined()
  })

  it('supplies the SubtleCrypto provider on the Workers runtime', async () => {
    asWorkers()
    const event = { id: 'evt_3', type: 'payment_intent.succeeded' }
    const constructEventAsync = vi.fn().mockResolvedValue(event)
    const app = buildApp(constructEventAsync)
    app.post('/webhook', async (c) => {
      const e = await verifyStripeSignature(c, { secret: SECRET })
      return c.json({ type: e.type })
    })

    const res = await app.request('/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_abc' },
      body: '{"hello":"world"}',
    })

    expect(res.status).toBe(200)
    expect(constructEventAsync).toHaveBeenCalledTimes(1)
    const provider = constructEventAsync.mock.calls[0]![4]
    expect(provider).toBeDefined() // SubtleCrypto provider for edge runtimes
  })

  it('throws when the signature header is missing', async () => {
    const constructEventAsync = vi.fn()
    const app = buildApp(constructEventAsync)
    app.post('/webhook', async (c) => {
      await verifyStripeSignature(c, { secret: SECRET })
      return c.body(null, 200)
    })

    const res = await app.request('/webhook', { method: 'POST', body: '{}' })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('missing Stripe signature header')
    expect(constructEventAsync).not.toHaveBeenCalled()
  })

  it('returns 400 (not 500) when signature verification fails', async () => {
    const constructEventAsync = vi.fn().mockRejectedValue(new Error('No signatures found'))
    const app = buildApp(constructEventAsync)
    app.post('/webhook', async (c) => {
      await verifyStripeSignature(c, { secret: SECRET })
      return c.body(null, 200)
    })

    const res = await app.request('/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'bad_sig' },
      body: '{}',
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('No signatures found')
  })

  it('honors a custom signature header', async () => {
    const constructEventAsync = vi.fn().mockResolvedValue({ id: 'evt_2', type: 'charge.refunded' })
    const app = buildApp(constructEventAsync)
    app.post('/webhook', async (c) => {
      await verifyStripeSignature(c, { secret: SECRET, signatureHeader: 'x-sig' })
      return c.body(null, 200)
    })

    const res = await app.request('/webhook', {
      method: 'POST',
      headers: { 'x-sig': 'sig_xyz' },
      body: '{}',
    })
    expect(res.status).toBe(200)
    expect(constructEventAsync.mock.calls[0]![1]).toBe('sig_xyz')
  })
})
