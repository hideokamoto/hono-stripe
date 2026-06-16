import { Hono } from 'hono'
import Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stripeMiddleware } from '../src/middleware'
import {
  __resetCaches,
  getStripeClient,
  isNodeRuntime,
  isWorkersRuntime,
  shouldUseFetchHttpClient,
} from '../src/runtime'
import type { StripeEnv } from '../src/types'

const KEY = 'sk_test_123'

const buildApp = (options?: Parameters<typeof stripeMiddleware>[0]) => {
  const app = new Hono<StripeEnv>()
  app.onError((err, c) => c.text(err.message, 500))
  app.use(stripeMiddleware(options))
  app.get('/', (c) => c.json({ isStripe: c.var.stripe instanceof Stripe }))
  return app
}

// hono/adapter's env() reads c.env on the workerd runtime and process.env on
// node. Faking the user agent lets us exercise the real Workers binding path.
const asWorkers = () => vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' })

beforeEach(() => __resetCaches())
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.STRIPE_SECRET_KEY
  delete process.env.CUSTOM_KEY
})

describe('stripeMiddleware', () => {
  it('injects a Stripe client from an explicit apiKey', async () => {
    const res = await buildApp({ apiKey: KEY }).request('/')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ isStripe: true })
  })

  it('resolves the key from a Workers env binding', async () => {
    asWorkers()
    const res = await buildApp().request('/', undefined, { STRIPE_SECRET_KEY: KEY })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ isStripe: true })
  })

  it('resolves the key from process.env', async () => {
    process.env.STRIPE_SECRET_KEY = KEY
    const res = await buildApp().request('/')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ isStripe: true })
  })

  it('honors a custom secretKeyVar', async () => {
    asWorkers()
    const res = await buildApp({ secretKeyVar: 'CUSTOM_KEY' }).request('/', undefined, {
      CUSTOM_KEY: KEY,
    })
    expect(res.status).toBe(200)
  })

  it('throws a clear error when no key is found', async () => {
    const res = await buildApp().request('/')
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('Stripe secret key not found')
  })
})

describe('runtime', () => {
  it('detects Node and skips the fetch http client there', () => {
    expect(isNodeRuntime()).toBe(true)
    expect(isWorkersRuntime()).toBe(false)
    expect(shouldUseFetchHttpClient()).toBe(false)
  })

  it('caches one client per secret key', () => {
    const a = getStripeClient(KEY, {})
    const b = getStripeClient(KEY, {})
    const c = getStripeClient('sk_test_other', {})
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})
