import type Stripe from 'stripe'
import type { StripeClientConfig } from './runtime'

/**
 * Variables injected into the Hono context by {@link stripeMiddleware}.
 * Use together with {@link StripeEnv} so `c.var.stripe` is typed.
 */
export type StripeVariables = {
  stripe: Stripe
}

/**
 * Hono `Env` fragment contributed by hono-stripe.
 *
 * @example
 * ```ts
 * import { Hono } from 'hono'
 * import { stripeMiddleware, type StripeEnv } from 'hono-stripe'
 *
 * const app = new Hono<StripeEnv>()
 * app.use(stripeMiddleware())
 * app.post('/api/payment-intent', (c) => {
 *   c.var.stripe // typed as Stripe
 *   // ...
 * })
 * ```
 */
export type StripeEnv = {
  Variables: StripeVariables
}

/**
 * Options for {@link stripeMiddleware}.
 *
 * The secret key is resolved in this order:
 * 1. {@link StripeMiddlewareOptions.apiKey} (explicit)
 * 2. Cloudflare Workers env binding `c.env[secretKeyVar]`
 * 3. `process.env[secretKeyVar]` (Node)
 */
export interface StripeMiddlewareOptions {
  /** Secret key passed directly. Skips env-binding / process.env resolution. */
  apiKey?: string
  /** Name of the env binding / `process.env` key holding the secret key. Default: `STRIPE_SECRET_KEY`. */
  secretKeyVar?: string
  /** Stripe API version override. Defaults to the SDK's pinned version. */
  apiVersion?: StripeClientConfig['apiVersion']
  /**
   * Extra Stripe config. Merged last, so an explicit `httpClient` here
   * overrides the automatic Workers `createFetchHttpClient()` selection.
   */
  config?: StripeClientConfig
}
