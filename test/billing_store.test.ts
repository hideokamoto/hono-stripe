import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { BillingStore, BillingSubscriptionRow } from '../src/billing/types'
import { memoryBillingStore } from '../src/billing/store/memory'
import { sqlBillingStore } from '../src/billing/store/sql'
import { BILLING_SCHEMA_SQLITE } from '../src/billing/schema'

/**
 * The BillingStore contract — run against every adapter. The guard semantics
 * (written / stale / tie, force) are what the verified sync algorithm builds
 * on; an adapter that gets these wrong breaks the convergence proof.
 */
const describeBillingStoreContract = (name: string, makeStore: () => BillingStore) => {
  const row = (over: Partial<BillingSubscriptionRow> = {}): BillingSubscriptionRow => ({
    id: 'sub_1',
    userId: 'u1',
    stripeCustomerId: 'cus_1',
    status: 'active',
    priceIds: ['price_pro'],
    quantity: 1,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    trialEnd: null,
    endedAt: null,
    lastEventCreated: 10,
    raw: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  })
  const customer = { userId: 'u1', stripeCustomerId: 'cus_1', raw: null, createdAt: 0, updatedAt: 0 }

  describe(`BillingStore contract — ${name}`, () => {
    it('writes new rows and reports written/stale/tie per the event guard', async () => {
      const store = makeStore()
      expect(await store.upsertSubscription(row())).toBe('written')
      expect(await store.upsertSubscription(row({ lastEventCreated: 9 }))).toBe('stale')
      expect(await store.upsertSubscription(row({ lastEventCreated: 10 }))).toBe('tie')
      expect(await store.upsertSubscription(row({ lastEventCreated: 11 }))).toBe('written')
      expect((await store.getSubscriptionsByUserId('u1'))[0]?.lastEventCreated).toBe(11)
    })

    it('never lets an older event regress the row (the proven guard)', async () => {
      const store = makeStore()
      await store.upsertSubscription(row({ lastEventCreated: 10, status: 'trialing' }))
      await store.upsertSubscription(row({ lastEventCreated: 9, status: 'canceled' }))
      expect((await store.getSubscriptionsByUserId('u1'))[0]?.status).toBe('trialing')
    })

    it('force writes unconditionally (tie-refetch path)', async () => {
      const store = makeStore()
      await store.upsertSubscription(row({ lastEventCreated: 10 }))
      expect(
        await store.upsertSubscription(row({ lastEventCreated: 10, status: 'canceled' }), { force: true }),
      ).toBe('written')
      expect((await store.getSubscriptionsByUserId('u1'))[0]?.status).toBe('canceled')
    })

    it('customer upsert + lookup by both keys', async () => {
      const store = makeStore()
      await store.upsertCustomer(customer)
      expect((await store.getCustomerByUserId('u1'))?.stripeCustomerId).toBe('cus_1')
      expect((await store.getCustomerByStripeId('cus_1'))?.userId).toBe('u1')
    })

    it('relinkCustomer cascades userId to owned subscription rows', async () => {
      const store = makeStore()
      await store.upsertCustomer(customer)
      await store.upsertSubscription(row())
      await store.relinkCustomer('cus_1', 'u2')
      expect(await store.getSubscriptionsByUserId('u1')).toHaveLength(0)
      const relinked = await store.getSubscriptionsByUserId('u2')
      expect(relinked).toHaveLength(1)
      expect(relinked[0]?.userId).toBe('u2')
      expect((await store.getCustomerByStripeId('cus_1'))?.userId).toBe('u2')
    })
  })
}

describeBillingStoreContract('memory', () => memoryBillingStore())

const sqliteStore = (): BillingStore => {
  const db = new Database(':memory:')
  db.exec(BILLING_SCHEMA_SQLITE)
  const execute = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
    const stmt = db.prepare(sql)
    const bound = params.map((p) =>
      typeof p === 'boolean' ? Number(p) : Array.isArray(p) || (p !== null && typeof p === 'object') ? JSON.stringify(p) : p,
    )
    if (/returning/i.test(sql) || /^\s*select/i.test(sql)) {
      return stmt.all(...(bound as never[])) as Record<string, unknown>[]
    }
    stmt.run(...(bound as never[]))
    return []
  }
  return sqlBillingStore(execute)
}

describeBillingStoreContract('sql (sqlite)', sqliteStore)
