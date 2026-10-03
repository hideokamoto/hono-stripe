import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'
import type { BillingStore, BillingSubscriptionRow } from '../src/billing/types'
import { memoryBillingStore } from '../src/billing/store/memory'
import { billingSyncHandlers } from '../src/billing/sync'

/**
 * Spec-vector replay tests.
 *
 * Every fixture in test/fixtures/sync/ is an action schedule extracted from a
 * Quint MBT trace of spec/quint/billing_sync_2ev.qnt — the schedules include
 * the exact interleavings that produce counterexamples for the losing write
 * policies. The implementation encodes the verified policy
 * (fetch + lastEventCreated guard + refetch-on-tie, atomic store), so EVERY
 * atomic schedule must converge to the final truth.
 *
 * Regenerate with:
 *   quint run spec/quint/billing_sync_2ev.qnt --mbt \
 *     --out-itf=/tmp/traces/m_{#}.itf.json --n-traces=10000 --max-steps=12
 *   node spec/tools/itf2vector.mjs /tmp/traces test/fixtures/sync
 */

interface Vector {
  name: string
  policy: string
  storeAtomic: boolean
  snapshots: Record<string, number>
  events: string[]
  final: { truth: number; mirrorVersion: number; mirrorCreated: number; quiescent: boolean }
}

const vectors: Vector[] = readdirSync(join(__dirname, 'fixtures/sync'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(__dirname, 'fixtures/sync', f), 'utf8')))

/** A Stripe.Subscription carrying a hidden truth marker in testVersion. */
const makeSub = (version: number) =>
  ({
    id: 'sub_1',
    object: 'subscription',
    customer: 'cus_1',
    status: 'active',
    metadata: { user_id: 'u1' },
    items: {
      object: 'list',
      data: [
        {
          id: 'si_1',
          price: { id: 'price_pro' },
          quantity: 1,
          current_period_end: 1_700_000_000 + version,
        },
      ],
    },
    cancel_at_period_end: false,
    canceled_at: null,
    trial_end: null,
    ended_at: null,
    testVersion: version,
  }) as unknown as Stripe.Subscription

const makeEvent = (seq: number) =>
  ({
    id: `evt_${seq}`,
    type: 'customer.subscription.updated',
    created: 1, // both events share the same second — the tie case
    data: { object: { id: 'sub_1' } },
  }) as unknown as Stripe.Event

const getMirror = async (store: BillingStore): Promise<BillingSubscriptionRow | null> => {
  const subs = await store.getSubscriptionsByUserId('u1')
  return subs[0] ?? null
}

const versionOf = (row: BillingSubscriptionRow | null): number =>
  (row?.raw as { testVersion?: number } | null | undefined)?.testVersion ?? -1

/**
 * Replay one schedule against the real sync engine.
 *
 * Model mapping:
 * - `emit`        → Stripe-side truth advances (next retrieve sees new data)
 * - `deliverN`    → start the real handler; its retrieve is deferred,
 *                   capturing a snapshot of truth at deliver time (the model's
 *                   snapshot-at-handler-start semantics)
 * - `finishN`     → resolve handler N's retrieve; its write lands now
 * - refetches (tie) resolve immediately with the CURRENT truth — the
 *   model's `truthNow` at commit time.
 */
const replayAtomic = async (vector: Vector) => {
  let truth = 0
  const store = memoryBillingStore()
  const handlers = billingSyncHandlers({ store })

  // deliverQueue: seqs whose initial retrieve is outstanding.
  const deliverQueue: number[] = []
  const deferredByEvent = new Map<
    number,
    { captured: number; resolve: (s: Stripe.Subscription) => void }
  >()
  const retrieve = vi.fn((_id: string) => {
    const seq = deliverQueue[0]
    if (seq !== undefined) {
      deliverQueue.shift()
      const captured = truth
      return new Promise<Stripe.Subscription>((resolve) => {
        deferredByEvent.set(seq, { captured, resolve })
      })
    }
    return Promise.resolve(makeSub(truth))
  })
  const stripe = { subscriptions: { retrieve } } as unknown as Stripe
  const c = { get: (k: string) => (k === 'stripe' ? stripe : undefined) } as never

  const handlerPromises = new Map<number, Promise<unknown>>()
  const mirrorLog: Array<{ step: string; version: number }> = []

  for (const action of vector.events) {
    if (action === 'emit') {
      truth += 1
      continue
    }
    const deliver = action.match(/^deliver(\d)$/)
    if (deliver) {
      const seq = Number(deliver[1])
      deliverQueue.push(seq)
      const handler = handlers['customer.subscription.updated']
      if (!handler) throw new Error('missing subscription.updated handler')
      handlerPromises.set(seq, handler(makeEvent(seq), c))
      continue
    }
    const finish = action.match(/^finish(\d)$/)
    if (finish) {
      const seq = Number(finish[1])
      const d = deferredByEvent.get(seq)
      if (!d) throw new Error(`${vector.name}: finish${seq} before deliver`)
      d.resolve(makeSub(d.captured))
      await handlerPromises.get(seq)
      mirrorLog.push({ step: action, version: versionOf(await getMirror(store)) })
      continue
    }
    // KV-phase actions are replayed by the kv store test, not here.
    if (/^(begin|commit)\d$/.test(action)) throw new Error(`${vector.name}: KV action in atomic replay`)
    throw new Error(`${vector.name}: unknown action ${action}`)
  }
  await Promise.all(handlerPromises.values())
  return { store, mirrorLog, retrieve }
}

describe('sync vectors (spec/quint/billing_sync_2ev.qnt)', () => {
  const atomic = vectors.filter((v) => v.storeAtomic)
  it('has coverage', () => expect(atomic.length).toBeGreaterThanOrEqual(5))

  for (const vector of atomic) {
    it(`${vector.name} [${vector.policy} trace] converges at quiescence`, async () => {
      const { store, mirrorLog } = await replayAtomic(vector)
      // Every schedule must converge: verified invariant transplanted to code.
      expect(versionOf(await getMirror(store)), vector.events.join(' ')).toBe(2)
      // neverAhead: mirror never reports a version beyond Stripe truth.
      for (const s of mirrorLog) expect(s.version).toBeLessThanOrEqual(2)
    })
  }
})

describe('BillingStore contract (memory adapter)', () => {
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

  it('returns written/stale/tie per the lastEventCreated guard', async () => {
    const store = memoryBillingStore()
    expect(await store.upsertSubscription(row())).toBe('written')
    expect(await store.upsertSubscription(row({ lastEventCreated: 9 }))).toBe('stale')
    expect(await store.upsertSubscription(row({ lastEventCreated: 10 }))).toBe('tie')
    expect(await store.upsertSubscription(row({ lastEventCreated: 11 }))).toBe('written')
    expect((await store.getSubscriptionsByUserId('u1'))[0]?.lastEventCreated).toBe(11)
  })

  it('force writes unconditionally (tie-refetch path)', async () => {
    const store = memoryBillingStore()
    await store.upsertSubscription(row({ lastEventCreated: 10 }))
    expect(await store.upsertSubscription(row({ lastEventCreated: 10, status: 'canceled' }), { force: true })).toBe('written')
    expect((await store.getSubscriptionsByUserId('u1'))[0]?.status).toBe('canceled')
  })

  it('relinkCustomer cascades userId to owned subscription rows', async () => {
    const store = memoryBillingStore()
    await store.upsertCustomer({
      userId: 'u1', stripeCustomerId: 'cus_1', raw: null, createdAt: 0, updatedAt: 0,
    })
    await store.upsertSubscription(row())
    await store.relinkCustomer('cus_1', 'u2')
    expect(await store.getSubscriptionsByUserId('u1')).toHaveLength(0)
    expect(await store.getSubscriptionsByUserId('u2')).toHaveLength(1)
    expect((await store.getCustomerByStripeId('cus_1'))?.userId).toBe('u2')
  })
})

describe('sync engine — userId rules (spec/alloy/billing_link.als)', () => {
  const opts = () => ({ store: memoryBillingStore() })

  it('does not write a subscription whose userId is unresolvable', async () => {
    const store = memoryBillingStore()
    const warn = vi.fn()
    const handlers = billingSyncHandlers({ store, warn })
    const sub = { ...makeSub(1), metadata: {} }
    const stripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue(sub) },
      customers: { retrieve: vi.fn().mockResolvedValue({ id: 'cus_1', deleted: false, metadata: {} }) },
    } as unknown as Stripe
    const c = { get: () => stripe } as never
    await handlers['customer.subscription.created']?.(makeEvent(1), c)
    expect(await store.getSubscriptionsByUserId('u1')).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
  })

  it('userId resolution order: client_reference_id > session.metadata > subscription.metadata > customer.metadata', async () => {
    const store = memoryBillingStore()
    const handlers = billingSyncHandlers({ store })
    const stripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue(makeSub(1)) },
      customers: { retrieve: vi.fn().mockResolvedValue({ id: 'cus_1', deleted: false, metadata: { user_id: 'u_meta' } }) },
    } as unknown as Stripe
    const c = { get: () => stripe } as never
    const session = {
      id: 'cs_1', mode: 'subscription',
      client_reference_id: 'u_ref',
      metadata: { user_id: 'u_session' },
      customer: 'cus_1',
      subscription: { id: 'sub_1', metadata: { user_id: 'u_sub' } },
    }
    const event = { id: 'evt_c', type: 'checkout.session.completed', created: 5, data: { object: session } } as unknown as Stripe.Event
    await handlers['checkout.session.completed']?.(event, c)
    expect((await store.getCustomerByUserId('u_ref'))?.stripeCustomerId).toBe('cus_1')
  })
})
