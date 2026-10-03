import type { Context } from 'hono'

/**
 * Result of a guarded subscription upsert. Mirrors the verified write
 * decision in spec/quint/billing_sync_2ev.qnt:
 * - `written`: stored (new row, or strictly newer lastEventCreated).
 * - `stale`:   skipped — stored row has a newer lastEventCreated.
 * - `tie`:     skipped — same lastEventCreated. The sync engine re-reads
 *   the subscription from the API and rewrites unconditionally — the only
 *   policy proven to converge at quiescence.
 */
export type SubscriptionWriteResult = 'written' | 'stale' | 'tie'

export interface BillingCustomerRow {
  /** Application-side user id (1:1 with a Stripe customer). */
  userId: string
  stripeCustomerId: string
  /** Full Stripe.Customer object. */
  raw: unknown | null
  createdAt: number
  updatedAt: number
}

export interface BillingSubscriptionRow {
  /** Stripe subscription id (`sub_...`). */
  id: string
  /** Denormalized owner — lets entitlement answer with a single-table read. */
  userId: string
  stripeCustomerId: string
  /** Stripe status literal, stored verbatim. */
  status: string
  /** All item price ids on the subscription. */
  priceIds: string[]
  quantity: number | null
  /** Max of items[].current_period_end (Basil moved it onto items). */
  currentPeriodEnd: number | null
  cancelAtPeriodEnd: boolean
  canceledAt: number | null
  trialEnd: number | null
  endedAt: number | null
  /** event.created that produced this row — the ordering guard. */
  lastEventCreated: number
  /** Full Stripe.Subscription object. */
  raw: unknown | null
  createdAt: number
  updatedAt: number
}

export interface UpsertSubscriptionOptions {
  /** Skip the lastEventCreated guard (used by the tie-refetch write). */
  force?: boolean
}

/**
 * Storage boundary for the billing mirror. `drizzleBillingStore` is the
 * only correctness-complete adapter (atomic guard); `kvBillingStore` is
 * best-effort; `memoryBillingStore` is for dev/tests.
 */
export interface BillingStore {
  upsertCustomer(row: BillingCustomerRow): Promise<void>
  upsertSubscription(
    row: BillingSubscriptionRow,
    options?: UpsertSubscriptionOptions,
  ): Promise<SubscriptionWriteResult>
  getSubscriptionsByUserId(userId: string): Promise<BillingSubscriptionRow[]>
  getCustomerByUserId(userId: string): Promise<BillingCustomerRow | null>
  getCustomerByStripeId(stripeCustomerId: string): Promise<BillingCustomerRow | null>
  /** Re-owner a customer and cascade userId to all its subscription rows. */
  relinkCustomer(stripeCustomerId: string, userId: string): Promise<void>
}

export type BillingStoreResolver = BillingStore | ((c: Context) => BillingStore)

export const resolveBillingStore = (
  store: BillingStoreResolver,
  c: Context,
): BillingStore => (typeof store === 'function' ? store(c) : store)
