import type { Context } from 'hono'
import type Stripe from 'stripe'
import { getStripe } from './context'
import { getCryptoProvider } from './runtime'

const DEFAULT_SIGNATURE_HEADER = 'stripe-signature'

export interface VerifyStripeSignatureOptions {
  /** Webhook signing secret (`whsec_...`). */
  secret: string
  /** Header carrying the signature. Default: `stripe-signature`. */
  signatureHeader?: string
  /** Allowed timestamp tolerance in seconds. Defaults to Stripe's value (300s). */
  tolerance?: number
}

/**
 * Verify a Stripe webhook signature and return the parsed, verified event.
 *
 * This is intentionally a thin primitive: it reads the raw body, verifies the
 * signature with `constructEventAsync` (the async form required on Cloudflare
 * Workers, where WebCrypto is async), and returns the `Stripe.Event`.
 *
 * It deliberately does **not** do event routing or per-type dispatch — that is
 * the job of `@kotodayori/hono`, which offers typed webhook routing on top of a
 * verified event. Reach for that when you outgrow this primitive.
 *
 * @throws if the signature header is missing or verification fails.
 *
 * @example
 * ```ts
 * app.post('/api/webhook', async (c) => {
 *   const event = await verifyStripeSignature(c, { secret: c.env.STRIPE_WEBHOOK_SECRET })
 *   // hand `event` to @kotodayori/hono for typed routing, or switch on event.type
 *   return c.body(null, 200)
 * })
 * ```
 */
export const verifyStripeSignature = async (
  c: Context,
  options: VerifyStripeSignatureOptions,
): Promise<Stripe.Event> => {
  const stripe = getStripe(c)
  const signature = c.req.header(options.signatureHeader ?? DEFAULT_SIGNATURE_HEADER)
  if (!signature) {
    throw new Error('hono-stripe: missing Stripe signature header on webhook request.')
  }
  const payload = await c.req.text()
  return stripe.webhooks.constructEventAsync(
    payload,
    signature,
    options.secret,
    options.tolerance,
    getCryptoProvider(),
  )
}
