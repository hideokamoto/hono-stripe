import type { MiddlewareHandler } from 'hono'
import { env } from 'hono/adapter'
import { getStripeClient } from './runtime'
import type { StripeEnv, StripeMiddlewareOptions } from './types'

const DEFAULT_SECRET_KEY_VAR = 'STRIPE_SECRET_KEY'

/**
 * Hono middleware that initializes a Stripe client and injects it at
 * `c.var.stripe`.
 *
 * - Resolves the secret key from an explicit option, a Cloudflare Workers env
 *   binding, or `process.env` — in that order.
 * - On edge runtimes (Workers) it automatically applies
 *   `Stripe.createFetchHttpClient()` so the SDK works without Node's HTTP stack.
 * - Clients are cached per secret key and reused across requests.
 *
 * @example
 * ```ts
 * const app = new Hono<StripeEnv>()
 * app.use(stripeMiddleware()) // reads STRIPE_SECRET_KEY from env binding / process.env
 * ```
 */
export const stripeMiddleware = (
  options: StripeMiddlewareOptions = {},
): MiddlewareHandler<StripeEnv> => {
  const secretKeyVar = options.secretKeyVar ?? DEFAULT_SECRET_KEY_VAR
  // When apiKey is known at registration time, build the client once and reuse it.
  const staticStripe = options.apiKey ? getStripeClient(options.apiKey, options) : undefined
  return async (c, next) => {
    let stripe = staticStripe
    if (!stripe) {
      const apiKey = env<Record<string, string | undefined>>(c)[secretKeyVar]
      if (!apiKey) {
        throw new Error(
          `hono-stripe: Stripe secret key not found. Pass { apiKey } or set the "${secretKeyVar}" env binding / process.env value.`,
        )
      }
      stripe = getStripeClient(apiKey, options)
    }
    c.set('stripe', stripe)
    await next()
  }
}
