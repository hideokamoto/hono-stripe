import { Hono } from 'hono'
import type Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'
import { verifyStripeSignature } from '../src/webhook'
import type { StripeEnv } from '../src/types'

const SECRET = 'whsec_test'

const buildApp = (constructEventAsync: ReturnType<typeof vi.fn>) => {
  const app = new Hono<StripeEnv>()
  app.onError((err, c) => c.text(err.message, 500))
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
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('missing Stripe signature header')
    expect(constructEventAsync).not.toHaveBeenCalled()
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
