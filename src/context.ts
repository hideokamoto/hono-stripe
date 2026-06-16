import type { Context } from 'hono'
import type Stripe from 'stripe'

/**
 * Read the Stripe client injected by {@link stripeMiddleware} from the context.
 *
 * Throws a clear error if the middleware has not run, so misconfiguration
 * fails fast instead of surfacing as an opaque `undefined` later.
 */
export const getStripe = (c: Context): Stripe => {
  const stripe = c.get('stripe') as Stripe | undefined
  if (!stripe) {
    throw new Error(
      'hono-stripe: Stripe client not found on context. Did you register stripeMiddleware() before this handler?',
    )
  }
  return stripe
}
