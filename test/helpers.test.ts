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
    expect(create).toHaveBeenCalledWith({ amount: 1400, currency: 'usd' }, undefined)
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
    expect(create).toHaveBeenCalledWith({ ui_mode: 'embedded_page', mode: 'payment' }, undefined)
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
