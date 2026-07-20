import type { Context } from 'hono'
import type Stripe from 'stripe'
import { getStripe } from './context'

/**
 * Return a copy of `options` that is guaranteed to carry an `idempotencyKey`.
 *
 * If the caller already supplied `options.idempotencyKey` it is preserved
 * untouched; otherwise a freshly generated `crypto.randomUUID()` is used. The
 * caller's object is never mutated — a new object is always returned.
 *
 * Throws a clear error (rather than a raw `TypeError`) if `crypto.randomUUID`
 * is unavailable in the current runtime — pass a stable `options.idempotencyKey`
 * explicitly in that case instead of relying on auto-generation.
 */
const withIdempotencyKey = (options?: Stripe.RequestOptions): Stripe.RequestOptions => {
  if (options?.idempotencyKey) {
    return { ...options, idempotencyKey: options.idempotencyKey }
  }
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error(
      'hono-stripe: crypto.randomUUID is not available in this runtime to auto-generate an idempotency key. Pass a stable { idempotencyKey } explicitly.',
    )
  }
  return { ...options, idempotencyKey: globalThis.crypto.randomUUID() }
}

/**
 * Create a PaymentIntent using the Stripe client on the context.
 *
 * The returned `client_secret` is what the frontend (e.g. the
 * `<stripe-payment-element>` web component from stripe-pwa-elements) needs to
 * confirm the payment.
 *
 * Security note: decide `amount`/`currency` on the server from a trusted source
 * (price IDs, a cart looked up by id) rather than trusting values sent by the
 * client. See the README for the recommended pattern.
 *
 * Idempotency note: when the caller does not supply `options.idempotencyKey`,
 * a fresh per-call `crypto.randomUUID()` is set as the idempotency key. This
 * only protects stripe-node's own automatic network retries of a single
 * invocation — it does NOT protect against a client double-submitting the same
 * request, because every server invocation generates a brand new key. To guard
 * against client-side duplicate submissions, pass a STABLE `idempotencyKey` via
 * `options`, derived from the business operation (e.g. a cart id or order id),
 * so retries of the same logical operation collapse to one PaymentIntent.
 *
 * @example
 * ```ts
 * app.post('/api/payment-intent', async (c) => {
 *   const intent = await createPaymentIntent(c, { amount: 1400, currency: 'usd' })
 *   return c.json({ clientSecret: intent.client_secret })
 * })
 * ```
 */
export const createPaymentIntent = (
  c: Context,
  params: Stripe.PaymentIntentCreateParams,
  options?: Stripe.RequestOptions,
): Promise<Stripe.PaymentIntent> =>
  getStripe(c).paymentIntents.create(params, withIdempotencyKey(options))

/**
 * Create a Checkout Session.
 *
 * This is a thin pass-through over `stripe.checkout.sessions.create` — it does
 * not hard-code a `ui_mode`, since the accepted values differ across the Stripe
 * versions this package supports as a peer. To drive the frontend with a
 * `client_secret` (the Checkout Sessions mode used by stripe-pwa-elements),
 * pass the client-side UI mode for your Stripe version (e.g. `ui_mode: 'custom'`
 * on recent Stripe, `'elements'` on older SDKs).
 *
 * Idempotency note: when the caller does not supply `options.idempotencyKey`,
 * a fresh per-call `crypto.randomUUID()` is set as the idempotency key. This
 * only protects stripe-node's own automatic network retries of a single
 * invocation — it does NOT protect against a client double-submitting the same
 * request, because every server invocation generates a brand new key. To guard
 * against client-side duplicate submissions, pass a STABLE `idempotencyKey` via
 * `options`, derived from the business operation (e.g. a cart id or order id),
 * so retries of the same logical operation collapse to one Checkout Session.
 *
 * @example
 * ```ts
 * app.post('/api/checkout-session', async (c) => {
 *   const session = await createCheckoutSession(c, {
 *     ui_mode: 'custom',
 *     mode: 'payment',
 *     line_items: [{ price: 'price_123', quantity: 1 }],
 *   })
 *   return c.json({ clientSecret: session.client_secret })
 * })
 * ```
 */
export const createCheckoutSession = (
  c: Context,
  params: Stripe.Checkout.SessionCreateParams,
  options?: Stripe.RequestOptions,
): Promise<Stripe.Checkout.Session> =>
  getStripe(c).checkout.sessions.create(params, withIdempotencyKey(options))
