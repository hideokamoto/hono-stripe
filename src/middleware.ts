import type { Context, MiddlewareHandler } from 'hono'
import { getStripeClient } from './runtime'
import type { StripeEnv, StripeMiddlewareOptions } from './types'

const DEFAULT_SECRET_KEY_VAR = 'STRIPE_SECRET_KEY'

/**
 * Resolve the Stripe secret key from (in order): explicit option,
 * Workers env binding, then `process.env`.
 */
const resolveApiKey = (
  c: Context,
  options: StripeMiddlewareOptions,
  secretKeyVar: string,
): string | undefined => {
  if (options.apiKey) return options.apiKey

  const env = c.env as Record<string, string | undefined> | undefined
  if (env?.[secretKeyVar]) return env[secretKeyVar]

  if (typeof process !== 'undefined' && process.env?.[secretKeyVar]) {
    return process.env[secretKeyVar]
  }

  return undefined
}

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
  return async (c, next) => {
    const apiKey = resolveApiKey(c, options, secretKeyVar)
    if (!apiKey) {
      throw new Error(
        `hono-stripe: Stripe secret key not found. Pass { apiKey } or set the "${secretKeyVar}" env binding / process.env value.`,
      )
    }
    c.set('stripe', getStripeClient(apiKey, options))
    await next()
  }
}
