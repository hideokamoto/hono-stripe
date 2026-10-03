import type { Context, MiddlewareHandler } from 'hono'
import type { BillingStore, BillingSubscriptionRow } from './types'

export type PlansConfig = Record<string, string | string[]>

export const DEFAULT_ENTITLED_STATUSES = ['active', 'trialing'] as const

/** Lower number wins when a user holds multiple subscriptions. */
const STATUS_PRIORITY: Record<string, number> = {
  active: 0,
  trialing: 1,
  past_due: 2,
  unpaid: 3,
  paused: 4,
  incomplete: 5,
  incomplete_expired: 6,
  canceled: 7,
}

const statusPriority = (status: string): number => STATUS_PRIORITY[status] ?? 8

/**
 * Deterministic "best" subscription pick (Alloy: TwoEntitledSubs — the rule
 * must be specified, not left to row order). Order: status rank, then newest
 * lastEventCreated, then id for a total order.
 */
export const pickBestSubscription = (
  subs: BillingSubscriptionRow[],
): BillingSubscriptionRow | null => {
  if (subs.length === 0) return null
  const sorted = [...subs].sort(
    (a, b) =>
      statusPriority(a.status) - statusPriority(b.status) ||
      b.lastEventCreated - a.lastEventCreated ||
      a.id.localeCompare(b.id),
  )
  return sorted[0] ?? null
}

export const matchPlan = (
  priceIds: string[],
  plans: PlansConfig,
): string | null => {
  const set = new Set(priceIds)
  for (const [plan, prices] of Object.entries(plans)) {
    const list = Array.isArray(prices) ? prices : [prices]
    if (list.some((p) => set.has(p))) return plan
  }
  return null
}

export interface BillingState {
  userId: string
  customerId: string | null
  /** The matched plan key, or null. */
  plan: string | null
  /** Best subscription's Stripe status, or null when none exists. */
  status: string | null
  /** status ∈ allowedStatuses (default: active, trialing). */
  entitled: boolean
  subscription: BillingSubscriptionRow | null
  currentPeriodEnd: number | null
  cancelAtPeriodEnd: boolean
  trialEnd: number | null
}

export interface GetStateOptions {
  /** Statuses that count as entitled. Default: ['active', 'trialing']. */
  allowedStatuses?: readonly string[]
}

export const getBillingState = async (
  store: BillingStore,
  userId: string,
  plans: PlansConfig = {},
  options?: GetStateOptions,
): Promise<BillingState> => {
  const allowed = new Set(options?.allowedStatuses ?? DEFAULT_ENTITLED_STATUSES)
  const [subs, customer] = await Promise.all([
    store.getSubscriptionsByUserId(userId),
    store.getCustomerByUserId(userId),
  ])
  const best = pickBestSubscription(subs)
  return {
    userId,
    customerId: customer?.stripeCustomerId ?? best?.stripeCustomerId ?? null,
    plan: best ? matchPlan(best.priceIds, plans) : null,
    status: best?.status ?? null,
    entitled: best !== null && allowed.has(best.status),
    subscription: best,
    currentPeriodEnd: best?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: best?.cancelAtPeriodEnd ?? false,
    trialEnd: best?.trialEnd ?? null,
  }
}

export interface RequirePlanOptions {
  /** Custom denial response. Default: 403 JSON `{ error, required, current }`. */
  onDenied?: (c: Context, state: BillingState) => Response | Promise<Response>
  /** Statuses that count as entitled. Default: ['active', 'trialing']. */
  allowedStatuses?: readonly string[]
  /** Redirect target for page routes (takes precedence over the JSON default). */
  redirect?: string
}

export const requirePlanMiddleware = (
  requiredPlans: string[],
  getState: (c: Context) => Promise<BillingState>,
  options?: RequirePlanOptions,
): MiddlewareHandler => {
  const required = new Set(requiredPlans)
  return async (c, next) => {
    const state = await getState(c)
    const allowed = new Set(options?.allowedStatuses ?? DEFAULT_ENTITLED_STATUSES)
    const statusOk =
      state.subscription !== null && allowed.has(state.subscription.status)
    const planOk = state.plan !== null && required.has(state.plan)
    if (!statusOk || !planOk) {
      if (options?.onDenied) return options.onDenied(c, state)
      if (options?.redirect) return c.redirect(options.redirect)
      return c.json(
        { error: 'plan_required', required: requiredPlans, current: state.plan },
        403,
      )
    }
    c.set('billing', state)
    return next()
  }
}
