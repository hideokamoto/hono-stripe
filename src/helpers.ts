import type { Context } from 'hono'
import type Stripe from 'stripe'
import { getStripe } from './context'

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
): Promise<Stripe.PaymentIntent> => getStripe(c).paymentIntents.create(params, options)

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
): Promise<Stripe.Checkout.Session> => getStripe(c).checkout.sessions.create(params, options)
