import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { stripeErrorHandler } from '../src/errors'

const makeApp = (thrower: () => never, fallback?: (e: Error) => Response) => {
  const app = new Hono()
  app.onError(stripeErrorHandler(fallback ? { fallback } : undefined))
  app.get('/boom', () => thrower())
  return app
}

describe('stripeErrorHandler', () => {
  it('maps StripeCardError → 402 with decline_code', async () => {
    const err = new Stripe.errors.StripeCardError({
      type: 'card_error',
      message: 'Your card was declined.',
      decline_code: 'insufficient_funds',
      requestId: 'req_123',
    } as never)
    const res = await makeApp(() => { throw err }).request('/boom')
    expect(res.status).toBe(402)
    const body = await res.json()
    expect(body.error.type).toBe('card_error')
    expect(body.error.code).toBe('insufficient_funds')
    expect(body.error.requestId).toBe('req_123')
  })

  it('maps StripeInvalidRequestError → 400', async () => {
    const err = new Stripe.errors.StripeInvalidRequestError({
      type: 'invalid_request_error',
      message: 'Missing required param: amount.',
    } as never)
    const res = await makeApp(() => { throw err }).request('/boom')
    expect(res.status).toBe(400)
    expect((await res.json()).error.type).toBe('invalid_request')
  })

  it('maps StripeIdempotencyError → 409', async () => {
    const err = new Stripe.errors.StripeIdempotencyError({
      type: 'idempotency_error',
      message: 'Keys for non-idempotent requests can only be used once.',
    } as never)
    const res = await makeApp(() => { throw err }).request('/boom')
    expect(res.status).toBe(409)
  })

  it('maps StripeSignatureVerificationError → 400 (no details leaked)', async () => {
    const err = new Stripe.errors.StripeSignatureVerificationError(
      'sig',
      'payload',
      { type: 'signature_verification_error' } as never,
    )
    const res = await makeApp(() => { throw err }).request('/boom')
    expect(res.status).toBe(400)
    expect((await res.json()).error.type).toBe('signature_verification_failed')
  })

  it('maps StripeRateLimitError → 429', async () => {
    const err = new Stripe.errors.StripeRateLimitError({
      type: 'rate_limit_error',
      message: 'Too many requests.',
    } as never)
    const res = await makeApp(() => { throw err }).request('/boom')
    expect(res.status).toBe(429)
  })

  it('maps StripeConnectionError/StripeAPIError → 502', async () => {
    const conn = new Stripe.errors.StripeConnectionError({
      type: 'api_connection_error',
      message: 'Network error.',
    } as never)
    const res = await makeApp(() => { throw conn }).request('/boom')
    expect(res.status).toBe(502)
  })

  it('maps StripeAuthenticationError → 500 without leaking the raw message', async () => {
    const err = new Stripe.errors.StripeAuthenticationError({
      type: 'authentication_error',
      message: 'Invalid API Key provided: sk_live_****SENSITIVE****',
    } as never)
    const res = await makeApp(() => { throw err }).request('/boom')
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.message).toBe('Stripe integration is misconfigured.')
    expect(JSON.stringify(body)).not.toContain('sk_live')
  })

  it('passes HTTPException through untouched', async () => {
    const res = await makeApp(() => {
      throw new HTTPException(404, { message: 'nope' })
    }).request('/boom')
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('nope')
  })

  it('returns a generic 500 for non-Stripe errors', async () => {
    const res = await makeApp(() => {
      throw new Error('database exploded')
    }).request('/boom')
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).toContain('internal_error')
    expect(text).not.toContain('exploded')
  })

  it('delegates non-Stripe errors to options.fallback when given', async () => {
    const res = await makeApp(
      () => {
        throw new Error('custom')
      },
      (e) => new Response(`handled: ${e.message}`, { status: 503 }),
    ).request('/boom')
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('handled: custom')
  })

  it('uses statusCode for unknown StripeError subclasses with 4xx', async () => {
    const err = new Stripe.errors.StripeError({
      type: 'unknown',
      message: 'weird',
      statusCode: 422,
    } as never)
    const res = await makeApp(() => { throw err }).request('/boom')
    expect(res.status).toBe(422)
  })
})
