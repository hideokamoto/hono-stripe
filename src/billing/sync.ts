import type { Context } from 'hono'
import type Stripe from 'stripe'
import type { StripeWebhookHandlers } from '../webhooks'
import type {
  BillingStore,
  BillingStoreResolver,
  BillingSubscriptionRow,
} from './types'
import { resolveBillingStore } from './types'

const DEFAULT_USER_ID_KEY = 'user_id'

export interface BillingSyncOptions {
  store: BillingStoreResolver
  /** Metadata key carrying the app user id. Default: `user_id`. */
  userIdKey?: string
  /** Custom user-id resolver; overrides the metadata convention. */
  resolveUserId?: (obj: { metadata?: Stripe.Metadata | null }) => string | null | undefined
  /** Sink for orphan-subscription reports. Default: console.warn. */
  warn?: (message: string) => void
}

const expand: { expand: string[] } = { expand: ['items.data.price'] }

const getStripeFromContext = (c: Context): Stripe => {
  const stripe = c.get('stripe') as Stripe | undefined
  if (!stripe) {
    throw new Error(
      'hono-stripe/billing: no Stripe client on context. Register stripeMiddleware() before the webhook route.',
    )
  }
  return stripe
}

const metadataOf = (
  obj: { metadata?: Stripe.Metadata | null } | string | null | undefined,
): Stripe.Metadata | undefined =>
  obj !== null && typeof obj === 'object' ? (obj.metadata ?? undefined) : undefined

const customerIdOf = (
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
): string | null =>
  typeof customer === 'string' ? customer : (customer?.id ?? null)

const resolveUserId = (
  opts: BillingSyncOptions,
  ...sources: Array<{ metadata?: Stripe.Metadata | null } | string | null | undefined>
): string | null => {
  const key = opts.userIdKey ?? DEFAULT_USER_ID_KEY
  for (const source of sources) {
    const metadata = metadataOf(source)
    if (!metadata) continue
    const resolved = opts.resolveUserId
      ? opts.resolveUserId({ metadata })
      : metadata[key]
    if (resolved) return resolved
  }
  return null
}

/**
 * Map a Stripe.Subscription to a mirror row. Reads current_period_end from
 * subscription items (Basil moved it off the subscription object), falling
 * back to the legacy top-level field for pre-Basil payloads.
 */
export const mapSubscription = (
  sub: Stripe.Subscription,
  userId: string,
  lastEventCreated: number,
): BillingSubscriptionRow => {
  const items = sub.items?.data ?? []
  const itemPeriodEnd = items
    .map((i) => i.current_period_end)
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => b - a)[0]
  const legacy = (sub as { current_period_end?: number | null }).current_period_end
  const now = Math.floor(Date.now() / 1000)
  return {
    id: sub.id,
    userId,
    stripeCustomerId: customerIdOf(sub.customer) ?? '',
    status: sub.status,
    priceIds: items
      .map((i) => (typeof i.price === 'string' ? i.price : i.price?.id))
      .filter((v): v is string => typeof v === 'string'),
    quantity: items[0]?.quantity ?? null,
    currentPeriodEnd: itemPeriodEnd ?? legacy ?? null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    canceledAt: sub.canceled_at ?? null,
    trialEnd: sub.trial_end ?? null,
    endedAt: sub.ended_at ?? null,
    lastEventCreated,
    raw: sub,
    createdAt: now,
    updatedAt: now,
  }
}

type ResolvedBillingSyncOptions = Omit<BillingSyncOptions, 'store'> & {
  store: BillingStore
}

const resolveUserIdForSubscription = async (
  opts: ResolvedBillingSyncOptions,
  stripe: Stripe,
  sub: Stripe.Subscription,
): Promise<string | null> => {
  const direct = resolveUserId(opts, sub)
  if (direct) return direct
  const customerId = customerIdOf(sub.customer)
  if (!customerId) return null
  const existing = await opts.store.getCustomerByStripeId(customerId)
  if (existing) return existing.userId
  // Last resort: customer.metadata on the Stripe side.
  const customer = await stripe.customers.retrieve(customerId)
  if (customer.deleted) return null
  return resolveUserId(opts, customer)
}

/**
 * The verified sync algorithm (spec/quint/billing_sync_2ev.qnt):
 * retrieve -> guarded write -> on tie, re-retrieve and write
 * unconditionally. The only policy proven to converge at quiescence.
 */
export const syncSubscriptionFromApi = async (
  opts: ResolvedBillingSyncOptions,
  stripe: Stripe,
  subscriptionId: string,
  lastEventCreated: number,
): Promise<void> => {
  const sub = await stripe.subscriptions.retrieve(subscriptionId, expand)
  const userId = await resolveUserIdForSubscription(opts, stripe, sub)
  if (!userId) {
    ;(opts.warn ?? console.warn)(
      `hono-stripe/billing: skipping ${subscriptionId} — no resolvable userId.`,
    )
    return
  }
  const result = await opts.store.upsertSubscription(
    mapSubscription(sub, userId, lastEventCreated),
  )
  if (result === 'tie') {
    const fresh = await stripe.subscriptions.retrieve(subscriptionId, expand)
    await opts.store.upsertSubscription(
      mapSubscription(fresh, userId, lastEventCreated),
      { force: true },
    )
  }
}

/**
 * Webhook handlers mirroring subscription state. Spread into
 * `stripeWebhook({ on: ... })` or compose with `mergeWebhookHandlers`.
 * Requires `stripeMiddleware` upstream (handlers use `c.var.stripe`).
 */
export const billingSyncHandlers = (opts: BillingSyncOptions): StripeWebhookHandlers => {
  const resolved = (c: Context): ResolvedBillingSyncOptions => ({
    ...opts,
    store: resolveBillingStore(opts.store, c),
  })
  const syncSub = (event: Stripe.CustomerSubscriptionCreatedEvent | Stripe.CustomerSubscriptionUpdatedEvent | Stripe.CustomerSubscriptionDeletedEvent, c: Context) =>
    syncSubscriptionFromApi(resolved(c), getStripeFromContext(c), event.data.object.id, event.created)

  return {
    'checkout.session.completed': async (event, c) => {
      const session = event.data.object
      if (session.mode !== 'subscription') return
      const stripe = getStripeFromContext(c)
      const store = resolved(c).store
      const customerId = customerIdOf(session.customer)
      // Resolution order (spec/alloy/billing_link.als):
      // client_reference_id > session.metadata > subscription.metadata > customer.metadata.
      const userId =
        session.client_reference_id ??
        resolveUserId(
          opts,
          session,
          session.subscription,
          session.customer as { metadata?: Stripe.Metadata | null } | string | null,
        )
      const subscriptionId =
        typeof session.subscription === 'string'
          ? session.subscription
          : (session.subscription?.id ?? null)

      if (userId && customerId) {
        const now = Math.floor(Date.now() / 1000)
        const existing = await store.getCustomerByStripeId(customerId)
        if (existing && existing.userId !== userId) {
          await store.relinkCustomer(customerId, userId)
        } else if (!existing) {
          await store.upsertCustomer({
            userId,
            stripeCustomerId: customerId,
            raw:
              session.customer !== null && typeof session.customer === 'object'
                ? session.customer
                : null,
            createdAt: now,
            updatedAt: now,
          })
        }
      } else if (customerId && !userId) {
        ;(opts.warn ?? console.warn)(
          `hono-stripe/billing: checkout.session.completed ${session.id} has no resolvable userId — customer ${customerId} left unlinked.`,
        )
      }

      if (subscriptionId) {
        await syncSubscriptionFromApi(resolved(c), stripe, subscriptionId, event.created)
      }
    },
    'customer.subscription.created': syncSub,
    'customer.subscription.updated': syncSub,
    'customer.subscription.deleted': syncSub,
  }
}
