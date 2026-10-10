import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { BillingStore, BillingSubscriptionRow } from '../src/billing/types'
import { memoryBillingStore } from '../src/billing/store/memory'
import {
  getBillingState,
  matchPlan,
  pickBestSubscription,
  type BillingEnv,
} from '../src/billing/entitlement'
import { stripeBilling } from '../src/billing'

/**
 * Entitlement semantics — the deterministic rules the Alloy model showed
 * cannot be left implicit (TwoEntitledSubs, status priority).
 */
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

describe('pickBestSubscription', () => {
  it('returns null on empty', () => {
    expect(pickBestSubscription([])).toBeNull()
  })

  it('prefers entitled statuses over later-created terminated ones', () => {
    const canceled = row({ id: 'sub_new', status: 'canceled', lastEventCreated: 99 })
    const active = row({ id: 'sub_old', status: 'active', lastEventCreated: 1 })
    expect(pickBestSubscription([canceled, active])?.id).toBe('sub_old')
  })

  it('breaks same-status ties by lastEventCreated desc', () => {
    const older = row({ id: 'sub_a', lastEventCreated: 5 })
    const newer = row({ id: 'sub_b', lastEventCreated: 8 })
    expect(pickBestSubscription([older, newer])?.id).toBe('sub_b')
  })

  it('is fully deterministic (id tie-break)', () => {
    const a = row({ id: 'sub_a', lastEventCreated: 5 })
    const b = row({ id: 'sub_b', lastEventCreated: 5 })
    expect(pickBestSubscription([b, a])?.id).toBe('sub_a')
    expect(pickBestSubscription([a, b])?.id).toBe('sub_a')
  })
})

describe('matchPlan', () => {
  const plans = { pro: 'price_pro', team: ['price_team_m', 'price_team_y'] }

  it('matches a price to its plan key', () => {
    expect(matchPlan(['price_pro'], plans)).toBe('pro')
    expect(matchPlan(['price_team_y'], plans)).toBe('team')
  })

  it('matches when any item price matches (multi-item subs)', () => {
    expect(matchPlan(['price_addon', 'price_team_m'], plans)).toBe('team')
  })

  it('returns null with no match or empty config', () => {
    expect(matchPlan(['price_other'], plans)).toBeNull()
    expect(matchPlan(['price_pro'], {})).toBeNull()
  })
})

describe('getBillingState', () => {
  it('entitled on active and trialing', async () => {
    const store = memoryBillingStore()
    await store.upsertSubscription(row({ status: 'trialing' }))
    const state = await getBillingState(store, 'u1', { pro: 'price_pro' })
    expect(state.entitled).toBe(true)
    expect(state.status).toBe('trialing')
    expect(state.plan).toBe('pro')
  })

  it('not entitled on past_due by default', async () => {
    const store = memoryBillingStore()
    await store.upsertSubscription(row({ status: 'past_due' }))
    const state = await getBillingState(store, 'u1')
    expect(state.entitled).toBe(false)
    expect(state.status).toBe('past_due')
  })

  it('honors custom allowedStatuses (grace-period use case)', async () => {
    const store = memoryBillingStore()
    await store.upsertSubscription(row({ status: 'past_due' }))
    const state = await getBillingState(store, 'u1', {}, { allowedStatuses: ['active', 'trialing', 'past_due'] })
    expect(state.entitled).toBe(true)
  })

  it('empty store yields non-entitled state with no subscription', async () => {
    const state = await getBillingState(memoryBillingStore(), 'u_nobody')
    expect(state).toMatchObject({ userId: 'u_nobody', entitled: false, plan: null, status: null, subscription: null })
  })
})

describe('stripeBilling factory', () => {
  const billing = stripeBilling({
    store: memoryBillingStore(),
    plans: { pro: 'price_pro', team: 'price_team_m' },
    user: (c) => c.get('session' as never) ?? 'u1',
  })

  it('checkoutParams populates all linkage fields', () => {
    const params = billing.checkoutParams('u1')
    expect(params).toMatchObject({
      client_reference_id: 'u1',
      metadata: { user_id: 'u1' },
      subscription_data: { metadata: { user_id: 'u1' } },
    })
  })

  it('requirePlan middleware: 403 JSON when plan mismatches', async () => {
    const store = memoryBillingStore()
    await store.upsertSubscription(row({ priceIds: ['price_pro'] }))
    const b = stripeBilling({ store, plans: { pro: 'price_pro', team: 'price_team_m' }, user: () => 'u1' })
    const app = new Hono()
    app.get('/team', b.requirePlan('team'), (c) => c.text('ok'))
    const res = await app.request('/team')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'plan_required' })
  })

  it('requirePlan middleware: passes and sets c.var.billing on match', async () => {
    const store = memoryBillingStore()
    await store.upsertSubscription(row({ priceIds: ['price_pro'] }))
    const b = stripeBilling({ store, plans: { pro: 'price_pro' }, user: () => 'u1' })
    const app = new Hono()
    app.get('/pro', b.requirePlan('pro'), (c) => c.json({ plan: (c.get('billing' as never) as { plan: string | null } | undefined)?.plan ?? null }))
    const res = await app.request('/pro')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ plan: 'pro' })
  })

  it('requirePlan middleware: 403 when no subscription', async () => {
    const b = stripeBilling({ store: memoryBillingStore(), plans: { pro: 'price_pro' }, user: () => 'u1' })
    const app = new Hono()
    app.get('/pro', b.requirePlan('pro'), (c) => c.text('ok'))
    expect((await app.request('/pro')).status).toBe(403)
  })

  it('requirePlan: array means any matching plan', async () => {
    const store = memoryBillingStore()
    await store.upsertSubscription(row({ priceIds: ['price_team_m'] }))
    const b = stripeBilling({ store, plans: { pro: 'price_pro', team: 'price_team_m' }, user: () => 'u1' })
    const app = new Hono()
    app.get('/x', b.requirePlan(['pro', 'team']), (c) => c.text('ok'))
    expect((await app.request('/x')).status).toBe(200)
  })

  it('requirePlan: custom onDenied wins over the JSON default', async () => {
    const store = memoryBillingStore()
    await store.upsertSubscription(row({ status: 'past_due' }))
    const b = stripeBilling({ store, plans: { pro: 'price_pro' }, user: () => 'u1' })
    const app = new Hono()
    app.get('/pro', b.requirePlan('pro', { onDenied: (c) => c.text('nope', 402) }), (c) => c.text('ok'))
    const res = await app.request('/pro')
    expect(res.status).toBe(402)
    expect(await res.text()).toBe('nope')
  })

  it('checkoutParams merges caller metadata without dropping the user link', () => {
    const params = billing.checkoutParams('u1', {
      metadata: { orderId: 'o1', user_id: 'spoofed' },
      subscriptionMetadata: { tier: 'gold' },
    })
    // The linkage key always wins — a caller's own user_id cannot shadow it.
    expect(params.metadata).toEqual({ orderId: 'o1', user_id: 'u1' })
    expect(params.subscription_data.metadata).toEqual({ tier: 'gold', user_id: 'u1' })
  })
})

describe('multi-subscription entitlement', () => {
  it('entitledPlans covers every entitled sub, plan stays the best pick', async () => {
    const store = memoryBillingStore()
    await store.upsertSubscription(row({ id: 'sub_pro', priceIds: ['price_pro'], lastEventCreated: 5 }))
    await store.upsertSubscription(row({ id: 'sub_basic', priceIds: ['price_basic'], lastEventCreated: 9 }))
    const state = await getBillingState(store, 'u1', { pro: 'price_pro', basic: 'price_basic' })
    expect(state.plan).toBe('basic') // best pick = newer event
    expect(state.entitledPlans.sort()).toEqual(['basic', 'pro'])
  })

  it('entitledPlans excludes non-entitled statuses and honors allowedStatuses', async () => {
    const store = memoryBillingStore()
    await store.upsertSubscription(row({ id: 's1', priceIds: ['price_pro'], status: 'past_due' }))
    expect(
      (await getBillingState(store, 'u1', { pro: 'price_pro' })).entitledPlans,
    ).toEqual([])
    expect(
      (
        await getBillingState(store, 'u1', { pro: 'price_pro' }, {
          allowedStatuses: ['past_due'],
        })
      ).entitledPlans,
    ).toEqual(['pro'])
  })

  it('requirePlan passes when any entitled sub matches — not just the best pick', async () => {
    const store = memoryBillingStore()
    // Older pro sub + newer basic sub: the best pick is basic, but the user
    // is still entitled to pro.
    await store.upsertSubscription(row({ id: 'sub_pro', priceIds: ['price_pro'], lastEventCreated: 5 }))
    await store.upsertSubscription(row({ id: 'sub_basic', priceIds: ['price_basic'], lastEventCreated: 9 }))
    const b = stripeBilling({
      store,
      plans: { pro: 'price_pro', basic: 'price_basic' },
      user: () => 'u1',
    })
    const app = new Hono()
    app.get('/pro', b.requirePlan('pro'), (c) => c.text('ok'))
    app.get('/basic', b.requirePlan('basic'), (c) => c.text('ok'))
    app.get('/team', b.requirePlan('team'), (c) => c.text('ok'))
    expect((await app.request('/pro')).status).toBe(200)
    expect((await app.request('/basic')).status).toBe(200)
    expect((await app.request('/team')).status).toBe(403)
  })

  it('requirePlan denies when the matching sub is not entitled', async () => {
    const store = memoryBillingStore()
    await store.upsertSubscription(row({ id: 's1', priceIds: ['price_pro'], status: 'canceled' }))
    const b = stripeBilling({ store, plans: { pro: 'price_pro' }, user: () => 'u1' })
    const app = new Hono()
    app.get('/pro', b.requirePlan('pro'), (c) => c.text('ok'))
    expect((await app.request('/pro')).status).toBe(403)
  })
})

describe('billing middleware', () => {
  const counting = (inner: BillingStore) => {
    let reads = 0
    const store: BillingStore = {
      ...inner,
      getSubscriptionsByUserId: async (u) => {
        reads++
        return inner.getSubscriptionsByUserId(u)
      },
      getCustomerByUserId: async (u) => {
        reads++
        return inner.getCustomerByUserId(u)
      },
    }
    return { store, reads: () => reads }
  }

  it('requirePlan reuses c.var.billing populated by middleware', async () => {
    const { store, reads } = counting(memoryBillingStore())
    await store.upsertSubscription(row({ priceIds: ['price_pro'] }))
    const b = stripeBilling({ store, plans: { pro: 'price_pro' }, user: () => 'u1' })
    const app = new Hono()
    app.use('/pro/*', b.middleware())
    app.get('/pro/x', b.requirePlan('pro'), (c) => c.text('ok'))
    expect((await app.request('/pro/x')).status).toBe(200)
    // 1 getSubs + 1 getCustomer for the whole request — not 4.
    expect(reads()).toBe(2)
  })

  it('custom allowedStatuses bypass the cached state and recompute', async () => {
    const { store, reads } = counting(memoryBillingStore())
    await store.upsertSubscription(row({ status: 'past_due', priceIds: ['price_pro'] }))
    const b = stripeBilling({ store, plans: { pro: 'price_pro' }, user: () => 'u1' })
    const app = new Hono()
    // middleware() caches state under default statuses (past_due → not
    // entitled); the gate below allows past_due, so it must recompute.
    app.use('/pro/*', b.middleware())
    app.get('/pro/x', b.requirePlan('pro', { allowedStatuses: ['past_due'] }), (c) => c.text('ok'))
    expect((await app.request('/pro/x')).status).toBe(200)
    expect(reads()).toBe(4)
  })

  it('BillingEnv types c.var.billing', async () => {
    const store = memoryBillingStore()
    await store.upsertSubscription(row({ priceIds: ['price_pro'] }))
    const b = stripeBilling({ store, plans: { pro: 'price_pro' }, user: () => 'u1' })
    const app = new Hono<BillingEnv>()
    app.use('/pro/*', b.middleware())
    app.get('/pro/x', (c) => c.json({ entitled: c.var.billing.entitled, plan: c.var.billing.plan }))
    const res = await app.request('/pro/x')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ entitled: true, plan: 'pro' })
  })

  it('unauthenticated requests (user resolver returns null) get 401', async () => {
    const b = stripeBilling({ store: memoryBillingStore(), plans: { pro: 'price_pro' }, user: () => null })
    const app = new Hono()
    app.get('/pro', b.requirePlan('pro'), (c) => c.text('ok'))
    expect((await app.request('/pro')).status).toBe(401)
  })

  it('a throwing user resolver warns and fails closed (401, not 500)', async () => {
    const warn = vi.fn()
    const b = stripeBilling({
      store: memoryBillingStore(),
      plans: { pro: 'price_pro' },
      warn,
      user: () => {
        throw new Error('auth middleware not mounted')
      },
    })
    const app = new Hono()
    app.get('/pro', b.requirePlan('pro'), (c) => c.text('ok'))
    expect((await app.request('/pro')).status).toBe(401)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('user resolver threw'))
  })
})
