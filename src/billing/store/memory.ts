import type {
  BillingCustomerRow,
  BillingStore,
  BillingSubscriptionRow,
  SubscriptionWriteResult,
  UpsertSubscriptionOptions,
} from '../types'

/**
 * In-memory BillingStore — development, tests, single-isolate workloads.
 * Semantically the atomic store (check and write in one step) with no
 * cross-isolate durability.
 */
export const memoryBillingStore = (): BillingStore => {
  const customers = new Map<string, BillingCustomerRow>()
  const subscriptions = new Map<string, BillingSubscriptionRow>()
  const customerByStripeId = new Map<string, string>() // stripeCustomerId -> userId

  return {
    upsertCustomer: async (row) => {
      customers.set(row.userId, row)
      customerByStripeId.set(row.stripeCustomerId, row.userId)
    },
    upsertSubscription: async (row, options?: UpsertSubscriptionOptions) => {
      const existing = subscriptions.get(row.id)
      if (!options?.force && existing) {
        if (row.lastEventCreated < existing.lastEventCreated) return 'stale'
        if (row.lastEventCreated === existing.lastEventCreated) return 'tie'
      }
      subscriptions.set(row.id, row)
      return 'written'
    },
    getSubscriptionsByUserId: async (userId) =>
      [...subscriptions.values()].filter((s) => s.userId === userId),
    getCustomerByUserId: async (userId) => customers.get(userId) ?? null,
    getCustomerByStripeId: async (stripeCustomerId) => {
      const userId = customerByStripeId.get(stripeCustomerId)
      return userId ? (customers.get(userId) ?? null) : null
    },
    relinkCustomer: async (stripeCustomerId, userId) => {
      const prevUserId = customerByStripeId.get(stripeCustomerId)
      if (prevUserId === undefined) return
      const customer = customers.get(prevUserId)
      customers.delete(prevUserId)
      if (customer) customers.set(userId, { ...customer, userId })
      customerByStripeId.set(stripeCustomerId, userId)
      for (const [id, sub] of subscriptions) {
        if (sub.stripeCustomerId === stripeCustomerId) {
          subscriptions.set(id, { ...sub, userId })
        }
      }
    },
  }
}
