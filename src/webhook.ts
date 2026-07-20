import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type Stripe from 'stripe'
import { getStripe } from './context'
import { getCryptoProvider, shouldUseFetchHttpClient } from './runtime'

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
 * The SubtleCrypto provider is only supplied on non-Node (edge) runtimes. On
 * Node the provider arg is left `undefined` so stripe-node auto-selects its
 * Node crypto provider — passing SubtleCrypto there would needlessly require a
 * global `crypto.subtle`.
 *
 * It deliberately does **not** do event routing or per-type dispatch — that is
 * the job of `@kotodayori/hono`, which offers typed webhook routing on top of a
 * verified event. Reach for that when you outgrow this primitive.
 *
 * @throws {HTTPException} 400 if the signature header is missing or
 * verification fails — the correct response to Stripe (a 500 would make Stripe
 * retry the delivery and pollute server error monitoring).
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
    throw new HTTPException(400, {
      message: 'hono-stripe: missing Stripe signature header on webhook request.',
    })
  }
  const payload = await c.req.text()
  // Only supply the SubtleCrypto provider on edge runtimes that need it. When
  // the provider arg is omitted (`undefined`), stripe-node auto-selects the
  // right one per runtime — its Node crypto provider on Node, SubtleCrypto on
  // the edge. Forcing SubtleCrypto onto Node would needlessly require a global
  // `crypto.subtle`, so we let stripe-node pick on Node.
  const cryptoProvider = shouldUseFetchHttpClient() ? getCryptoProvider() : undefined
  try {
    return await stripe.webhooks.constructEventAsync(
      payload,
      signature,
      options.secret,
      options.tolerance,
      cryptoProvider,
    )
  } catch (err) {
    throw new HTTPException(400, {
      message:
        err instanceof Error ? err.message : 'hono-stripe: webhook signature verification failed.',
      cause: err,
    })
  }
}
