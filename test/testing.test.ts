import Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import {
  createTestEvent,
  createWebhookRequest,
  signStripePayload,
} from '../src/testing'

const SECRET = 'whsec_test_signing_secret'
// constructEventAsync performs HMAC verification locally — no network needed.
const stripe = new Stripe('sk_test_123')

describe('signStripePayload', () => {
  it('produces a t=...,v1=... header that constructEventAsync accepts', async () => {
    const payload = JSON.stringify({ id: 'evt_1', type: 'ping' })
    const header = await signStripePayload(payload, SECRET)

    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)

    const event = await stripe.webhooks.constructEventAsync(payload, header, SECRET)
    expect(event.id).toBe('evt_1')
  })

  it('respects an explicit timestamp (old timestamps fail tolerance)', async () => {
    const payload = '{}'
    const old = Math.floor(Date.now() / 1000) - 3600
    const header = await signStripePayload(payload, SECRET, old)
    await expect(
      stripe.webhooks.constructEventAsync(payload, header, SECRET, 300),
    ).rejects.toThrow(/timestamp/i)
  })
})

describe('createTestEvent', () => {
  it('builds a Stripe.Event-shaped fixture around the object', () => {
    const event = createTestEvent('payment_intent.succeeded', { id: 'pi_1', amount: 1400 })
    expect(event.object).toBe('event')
    expect(event.type).toBe('payment_intent.succeeded')
    expect(event.data.object).toEqual({ id: 'pi_1', amount: 1400 })
    expect(event.id).toMatch(/^evt_test_/)
    expect(event.livemode).toBe(false)
  })
})

describe('createWebhookRequest', () => {
  it('returns a Request whose signature verifies end-to-end', async () => {
    const req = await createWebhookRequest(
      createTestEvent('checkout.session.completed', { id: 'cs_1' }),
      { secret: SECRET, url: 'http://localhost/webhook' },
    )

    expect(req.method).toBe('POST')
    expect(req.headers.get('stripe-signature')).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)

    const event = await stripe.webhooks.constructEventAsync(
      await req.text(),
      req.headers.get('stripe-signature')!,
      SECRET,
    )
    expect(event.type).toBe('checkout.session.completed')
  })

  it('accepts a pre-serialized payload and signs exactly those bytes', async () => {
    const payload = '{"a":1,  "b":[true]}'
    const req = await createWebhookRequest(payload, { secret: SECRET })
    expect(await req.text()).toBe(payload)
    const event = await stripe.webhooks.constructEventAsync(
      payload,
      req.headers.get('stripe-signature')!,
      SECRET,
    )
    expect(event).toBeTruthy()
  })
})
