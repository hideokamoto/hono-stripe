import type { Context, MiddlewareHandler } from 'hono'
import type Stripe from 'stripe'
import type { StripeWebhookHandlers } from '../webhooks'
import {
  billingSyncHandlers,
  mapSubscription,
  syncSubscriptionFromApi,
  type BillingSyncOptions,
} from './sync'
import {
  getBillingState,
  requirePlanMiddleware,
  type BillingState,
  type GetStateOptions,
  type PlansConfig,
  type RequirePlanOptions,
} from './entitlement'
import type {
  BillingStore,
  BillingStoreResolver,
  BillingSubscriptionRow,
} from './types'
import { resolveBillingStore } from './types'

const DEFAULT_USER_ID_KEY = 'user_id'

export interface StripeBillingOptions {
  /**
   * Where the mirror lives. Pass `sqlBillingStore(...)` for the
   * correctness-complete adapter, `memoryBillingStore()` for dev/tests, or a
   * function resolving a store per request (Workers bindings).
   */
  store: BillingStoreResolver
  /** Plan name -> Stripe price id(s). */
  plans?: PlansConfig
  /** Resolve the app user id from the request context (entitlement APIs). */
  user?: (c: Context) => string | Promise<string>
  /** Metadata key carrying the user id through checkout. Default: `user_id`. */
  userIdKey?: string
  /** Sink for orphan / unlinked reports. Default: console.warn. */
  warn?: (message: string) => void
}

export interface StripeBilling {
  /** Typed handlers to merge into `stripeWebhook({ on: ... })`. */
  handlers: StripeWebhookHandlers
  /** Entitlement snapshot for the current request's user. */
  getState: (c: Context, options?: GetStateOptions) => Promise<BillingState>
  /** All mirrored subscriptions for the current request's user. */
  getSubscriptions: (c: Context) => Promise<BillingSubscriptionRow[]>
  /** Gate routes by plan. `['pro', 'team']` means any matching plan. */
  requirePlan: (plan: string | string[], options?: RequirePlanOptions) => MiddlewareHandler
  /** Populates `c.var.billing` for downstream handlers. */
  middleware: () => MiddlewareHandler
  /** Fields to spread into checkout session params for userId linkage. */
  checkoutParams: (userId: string) => {
    client_reference_id: string
    metadata: Record<string, string>
    subscription_data: { metadata: Record<string, string> }
  }
  /** Reconcile the mirror against the Stripe API (KV best-effort recovery). */
  syncFromStripe: (c: Context, opts?: { userId?: string }) => Promise<{ synced: number }>
}

export const stripeBilling = (options: StripeBillingOptions): StripeBilling => {
  const userIdKey = options.userIdKey ?? DEFAULT_USER_ID_KEY
  const plans = options.plans ?? {}

  const storeOf = (c: Context): BillingStore => resolveBillingStore(options.store, c)

  const userIdOf = async (c: Context): Promise<string> => {
    if (!options.user) {
      throw new Error(
        'hono-stripe/billing: no `user` resolver configured — required for entitlement APIs.',
      )
    }
    return options.user(c)
  }

  const getState = async (c: Context, getStateOptions?: GetStateOptions): Promise<BillingState> =>
    getBillingState(storeOf(c), await userIdOf(c), plans, getStateOptions)

  const billing: StripeBilling = {
    handlers: billingSyncHandlers({ store: options.store, userIdKey, warn: options.warn }),

    getState,

    getSubscriptions: async (c) =>
      storeOf(c).getSubscriptionsByUserId(await userIdOf(c)),

    requirePlan: (plan, opts) =>
      requirePlanMiddleware(
        Array.isArray(plan) ? plan : [plan],
        (c) => getState(c, { allowedStatuses: opts?.allowedStatuses }),
        opts,
      ),

    middleware: () => async (c, next) => {
      c.set('billing', await getState(c))
      return next()
    },

    checkoutParams: (userId) => ({
      client_reference_id: userId,
      metadata: { [userIdKey]: userId },
      subscription_data: { metadata: { [userIdKey]: userId } },
    }),

    syncFromStripe: async (c, opts) => {
      const store = storeOf(c)
      const stripe = c.get('stripe') as Stripe | undefined
      if (!stripe) {
        throw new Error('hono-stripe/billing: no Stripe client on context.')
      }
      const userId = opts?.userId ?? (await userIdOf(c))
      const customer = await store.getCustomerByUserId(userId)
      if (!customer) return { synced: 0 }
      const list = await stripe.subscriptions.list({
        customer: customer.stripeCustomerId,
        status: 'all',
        limit: 100,
      })
      const now = Math.floor(Date.now() / 1000)
      for (const sub of list.data) {
        await store.upsertSubscription(mapSubscription(sub, userId, now))
      }
      return { synced: list.data.length }
    },
  }
  return billing
}

export { billingSyncHandlers, syncSubscriptionFromApi, mapSubscription }
export {
  getBillingState,
  pickBestSubscription,
  matchPlan,
  requirePlanMiddleware,
  DEFAULT_ENTITLED_STATUSES,
} from './entitlement'
export type { BillingState, GetStateOptions, PlansConfig, RequirePlanOptions, BillingSyncOptions }
export type {
  BillingStore,
  BillingStoreResolver,
  BillingCustomerRow,
  BillingSubscriptionRow,
  SubscriptionWriteResult,
  UpsertSubscriptionOptions,
} from './types'
export { resolveBillingStore } from './types'
export { memoryBillingStore } from './store/memory'
export { sqlBillingStore } from './store/sql'
export type { SqlExecutor, SqlDialect, SqlBillingStoreOptions } from './store/sql'
export { BILLING_SCHEMA_SQLITE, BILLING_SCHEMA_PG } from './schema'
