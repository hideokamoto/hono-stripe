import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stripeErrorHandler } from '../../src/errors'
import { stripeMiddleware } from '../../src/middleware'
import { __resetCaches } from '../../src/runtime'
import type { StripeEnv } from '../../src/types'
import { STRIPE_MOCK_URL, stripeMockConfig, TEST_KEY } from './stripe-mock'

/**
 * End-to-end through hono-stripe + the real stripe-node SDK + real HTTP,
 * with only the Stripe API replaced by stripe-mock.
 *
 * stripe-mock is stateless and does not simulate card declines, so those
 * paths stay covered by the unit tests (test/errors.test.ts).
 */

const buildApp = (options: Parameters<typeof stripeMiddleware>[0]) => {
  const app = new Hono<StripeEnv>()
  app.onError(stripeErrorHandler())
  app.use(stripeMiddleware(options))
  app.post('/payment-intents', async (c) => {
    const body = await c.req.json()
    return c.json(await c.var.stripe.paymentIntents.create(body))
  })
  return app
}

const post = (app: Hono<StripeEnv>, body: unknown) =>
  app.request('/payment-intents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

// See test/middleware.test.ts: faking the user agent makes hono's runtime
// detection report workerd, which switches the SDK to the Fetch HTTP client.
const asWorkers = () => vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' })

beforeEach(() => __resetCaches())
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('stripeMiddleware against stripe-mock', () => {
  it('passes `config` through to the SDK so requests reach the configured host', async () => {
    const res = await post(buildApp({ apiKey: TEST_KEY, config: stripeMockConfig() }), {
      amount: 1400,
      currency: 'jpy',
    })
    expect(res.status).toBe(200)
    const pi = await res.json()
    expect(pi.object).toBe('payment_intent')
    expect(pi.amount).toBe(1400)
    expect(pi.currency).toBe('jpy')
  })

  it('talks to Stripe through the Fetch HTTP client on Workers', async () => {
    asWorkers()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const res = await post(buildApp({ apiKey: TEST_KEY, config: stripeMockConfig() }), {
      amount: 500,
      currency: 'usd',
    })
    expect(res.status).toBe(200)
    expect((await res.json()).object).toBe('payment_intent')
    const urls = fetchSpy.mock.calls.map(([input]) =>
      input instanceof Request ? input.url : String(input),
    )
    expect(urls).toContain(`${STRIPE_MOCK_URL}/v1/payment_intents`)
  })

  it('does not use fetch on Node (stays on the Node HTTP client)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const res = await post(buildApp({ apiKey: TEST_KEY, config: stripeMockConfig() }), {
      amount: 500,
      currency: 'usd',
    })
    expect(res.status).toBe(200)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('stripeErrorHandler with errors raised by the real SDK', () => {
  it('maps a request validation failure to 400 invalid_request with the request id', async () => {
    const res = await post(buildApp({ apiKey: TEST_KEY, config: stripeMockConfig() }), {
      currency: 'jpy', // `amount` is required
    })
    expect(res.status).toBe(400)
    const { error } = await res.json()
    expect(error.type).toBe('invalid_request')
    expect(error.message).toContain('amount')
    expect(error.requestId).toMatch(/^req_/)
  })

  it('maps an authentication failure to a generic 500 without leaking key details', async () => {
    // stripe-mock answers 401 to anything that is not a test-mode secret key.
    const liveLookingKey = 'sk_live_must_not_leak'
    const res = await post(buildApp({ apiKey: liveLookingKey, config: stripeMockConfig() }), {
      amount: 1400,
      currency: 'jpy',
    })
    expect(res.status).toBe(500)
    const text = await res.text()
    const { error } = JSON.parse(text)
    expect(error.type).toBe('stripe_auth_error')
    expect(error.message).toBe('Stripe integration is misconfigured.')
    expect(text).not.toContain(liveLookingKey)
    expect(text).not.toContain('Authorization')
  })

  it.each([
    ['Node', () => {}],
    ['Workers (fetch)', asWorkers],
  ])('maps a connection failure to 502 stripe_unavailable on %s', async (_label, setup) => {
    setup()
    // Nothing listens on port 1, so the connection is refused.
    const res = await post(
      buildApp({ apiKey: TEST_KEY, config: { ...stripeMockConfig(), port: 1 } }),
      { amount: 1400, currency: 'jpy' },
    )
    expect(res.status).toBe(502)
    expect((await res.json()).error.type).toBe('stripe_unavailable')
  })
})
