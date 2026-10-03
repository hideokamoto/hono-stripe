import { describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { stripeCart } from '../src/ec/index'
import { memoryCartStore } from '../src/ec/store/memory'
import type { CartStore } from '../src/ec/types'

// Most cart ops never touch request state — `user` resolves the owner id
// and the store is passed directly. A bare object stands in for Context.
const c = {} as never

const setup = (userId = 'u1', store: CartStore = memoryCartStore()) =>
  stripeCart({ store, user: () => userId })

describe('CartStore contract — memory adapter', () => {
  it('put is absolute — overwrite same priceId, list, delete', async () => {
    const store = memoryCartStore()
    await store.put('u1', { priceId: 'p1', quantity: 1, addedAt: 10 })
    await store.put('u1', { priceId: 'p1', quantity: 3, addedAt: 20 })
    await store.put('u1', { priceId: 'p2', quantity: 2, addedAt: 10 })
    expect(await store.list('u1')).toEqual([
      { priceId: 'p1', quantity: 3, addedAt: 20 },
      { priceId: 'p2', quantity: 2, addedAt: 10 },
    ])
    await store.delete('u1', 'p1')
    expect(await store.list('u1')).toEqual([{ priceId: 'p2', quantity: 2, addedAt: 10 }])
  })

  it('carts are isolated by cartId', async () => {
    const store = memoryCartStore()
    await store.put('u1', { priceId: 'p1', quantity: 1, addedAt: 10 })
    expect(await store.list('u2')).toEqual([])
  })
})

describe('stripeCart — item ops (spec/quint/cart_ops.qnt)', () => {
  it('set is an absolute put — last write wins, one line per priceId', async () => {
    const cart = setup()
    await cart.set(c, 'price_a', 1)
    await cart.set(c, 'price_a', 3)
    expect(await cart.items(c)).toEqual([
      expect.objectContaining({ priceId: 'price_a', quantity: 3 }),
    ])
  })

  it('set with quantity <= 0 removes the line', async () => {
    const cart = setup()
    await cart.set(c, 'price_a', 2)
    await cart.set(c, 'price_a', 0)
    expect(await cart.items(c)).toEqual([])
  })

  it('remove deletes a single line and leaves others', async () => {
    const cart = setup()
    await cart.set(c, 'price_a', 1)
    await cart.set(c, 'price_b', 1)
    await cart.remove(c, 'price_a')
    expect(await cart.items(c)).toEqual([expect.objectContaining({ priceId: 'price_b' })])
  })

  it('clear empties the cart', async () => {
    const cart = setup()
    await cart.set(c, 'price_a', 1)
    await cart.set(c, 'price_b', 2)
    await cart.clear(c)
    expect(await cart.items(c)).toEqual([])
  })
})

describe('stripeCart — merge (spec/alloy/cart_link.als)', () => {
  it('folds the source cart in; shared priceId resolves to newer addedAt', async () => {
    const store = memoryCartStore()
    const cart = setup('u1', store)
    await store.put('sess_anon', { priceId: 'p1', quantity: 2, addedAt: 100 })
    await store.put('sess_anon', { priceId: 'p2', quantity: 1, addedAt: 100 })
    await store.put('u1', { priceId: 'p1', quantity: 1, addedAt: 200 })
    await store.put('u1', { priceId: 'p3', quantity: 5, addedAt: 50 })

    const { merged } = await cart.merge(c, 'sess_anon')
    const items = await cart.items(c)
    expect(items).toContainEqual({ priceId: 'p1', quantity: 1, addedAt: 200 })
    expect(items).toContainEqual({ priceId: 'p2', quantity: 1, addedAt: 100 })
    expect(items).toContainEqual({ priceId: 'p3', quantity: 5, addedAt: 50 })
    expect(merged).toBe(1) // only p2 was written into the target
    expect(await store.list('sess_anon')).toEqual([])
  })

  it('source line wins when it is newer', async () => {
    const store = memoryCartStore()
    const cart = setup('u1', store)
    await store.put('sess_anon', { priceId: 'p1', quantity: 9, addedAt: 300 })
    await store.put('u1', { priceId: 'p1', quantity: 1, addedAt: 100 })
    await cart.merge(c, 'sess_anon')
    expect(await cart.items(c)).toEqual([{ priceId: 'p1', quantity: 9, addedAt: 300 }])
  })

  it('addedAt tie resolves to the source line', async () => {
    const store = memoryCartStore()
    const cart = setup('u1', store)
    await store.put('sess_anon', { priceId: 'p1', quantity: 9, addedAt: 200 })
    await store.put('u1', { priceId: 'p1', quantity: 1, addedAt: 200 })
    await cart.merge(c, 'sess_anon')
    expect(await cart.items(c)).toEqual([{ priceId: 'p1', quantity: 9, addedAt: 200 }])
  })

  it('self-merge is a no-op, not a cart wipe', async () => {
    const cart = setup()
    await cart.set(c, 'p1', 2)
    expect(await cart.merge(c, 'u1')).toEqual({ merged: 0 })
    expect(await cart.items(c)).toEqual([expect.objectContaining({ priceId: 'p1' })])
  })
})

describe('stripeCart — checkout + drain (spec/quint/cart_ops.qnt)', () => {
  it('snapshots the view into session params: mode payment, client_reference_id, line_items', async () => {
    const cart = setup()
    await cart.set(c, 'price_a', 2)
    await cart.set(c, 'price_b', 1)
    const { items, params } = await cart.checkout(c)
    expect(params.mode).toBe('payment')
    expect(params.client_reference_id).toBe('u1')
    expect(params.line_items).toContainEqual({ price: 'price_a', quantity: 2 })
    expect(params.line_items).toContainEqual({ price: 'price_b', quantity: 1 })
    expect(items).toHaveLength(2)
  })

  it('refuses checkout on an empty cart (Alloy: EmptyCheckout)', async () => {
    await expect(setup().checkout(c)).rejects.toThrow(/empty/i)
  })

  it('refuses checkout when the cart owner id is unresolvable (Alloy: OrphanCheckout)', async () => {
    const cart = stripeCart({ store: memoryCartStore(), user: () => '' })
    await cart.set(c, 'price_a', 1)
    await expect(cart.checkout(c)).rejects.toThrow(/owner/i)
  })

  it('supports an async user resolver', async () => {
    const cart = stripeCart({ store: memoryCartStore(), user: async () => 'u_async' })
    await cart.set(c, 'price_a', 1)
    const { params } = await cart.checkout(c)
    expect(params.client_reference_id).toBe('u_async')
  })

  it('options.params merge last into the session params', async () => {
    const cart = setup()
    await cart.set(c, 'price_a', 1)
    const { params } = await cart.checkout(c, {
      params: { success_url: 'https://x/ok', cancel_url: 'https://x/no' },
    })
    expect(params.success_url).toBe('https://x/ok')
    expect(params.line_items).toEqual([{ price: 'price_a', quantity: 1 }])
  })

  it('drain deletes only snapshotted keys — post-snapshot adds survive', async () => {
    const cart = setup()
    await cart.set(c, 'p1', 1)
    const { items } = await cart.checkout(c) // snapshot = [p1]
    await cart.set(c, 'p2', 1) // post-snapshot add
    await cart.drain(
      c,
      items.map((i) => i.priceId),
    )
    expect(await cart.items(c)).toEqual([expect.objectContaining({ priceId: 'p2' })])
  })

  it('drain is idempotent', async () => {
    const cart = setup()
    await cart.set(c, 'p1', 1)
    await cart.drain(c, ['p1'])
    await cart.drain(c, ['p1'])
    expect(await cart.items(c)).toEqual([])
  })
})

describe('stripeCart — webhook handlers', () => {
  const sessionEvent = (mode: string, refId: string | null) =>
    ({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', mode, client_reference_id: refId } },
    }) as unknown as Stripe.CheckoutSessionCompletedEvent

  it('drains snapshotted keys of the cart named by client_reference_id', async () => {
    const store = memoryCartStore()
    const cart = setup('u1', store)
    await store.put('u1', { priceId: 'p1', quantity: 2, addedAt: 1 })
    await store.put('u1', { priceId: 'p2', quantity: 1, addedAt: 1 })
    const stripe = {
      checkout: {
        sessions: {
          listLineItems: vi
            .fn()
            .mockResolvedValue({ data: [{ price: { id: 'p1' }, quantity: 2 }] }),
        },
      },
    } as unknown as Stripe
    const wc = { get: (k: string) => (k === 'stripe' ? stripe : undefined) } as never

    await cart.handlers['checkout.session.completed']?.(sessionEvent('payment', 'u1'), wc)
    expect(await store.list('u1')).toEqual([{ priceId: 'p2', quantity: 1, addedAt: 1 }])
  })

  it('ignores non-payment sessions (subscription checkouts belong to billing)', async () => {
    const store = memoryCartStore()
    const cart = setup('u1', store)
    await store.put('u1', { priceId: 'p1', quantity: 2, addedAt: 1 })
    const stripe = {
      checkout: { sessions: { listLineItems: vi.fn() } },
    } as unknown as Stripe
    const wc = { get: () => stripe } as never

    await cart.handlers['checkout.session.completed']?.(sessionEvent('subscription', 'u1'), wc)
    expect(stripe.checkout.sessions.listLineItems).not.toHaveBeenCalled()
    expect(await store.list('u1')).toHaveLength(1)
  })

  it('ignores sessions without client_reference_id', async () => {
    const store = memoryCartStore()
    const cart = setup('u1', store)
    await store.put('u1', { priceId: 'p1', quantity: 2, addedAt: 1 })
    const stripe = {
      checkout: { sessions: { listLineItems: vi.fn() } },
    } as unknown as Stripe
    const wc = { get: () => stripe } as never

    await cart.handlers['checkout.session.completed']?.(sessionEvent('payment', null), wc)
    expect(stripe.checkout.sessions.listLineItems).not.toHaveBeenCalled()
    expect(await store.list('u1')).toHaveLength(1)
  })

  it('throws when no Stripe client is on context', async () => {
    const cart = setup()
    const wc = { get: () => undefined } as never
    await expect(
      cart.handlers['checkout.session.completed']?.(sessionEvent('payment', 'u1'), wc),
    ).rejects.toThrow(/no Stripe client/)
  })

  it('drains across listLineItems pages', async () => {
    const store = memoryCartStore()
    const cart = setup('u1', store)
    await store.put('u1', { priceId: 'p1', quantity: 1, addedAt: 1 })
    await store.put('u1', { priceId: 'p2', quantity: 1, addedAt: 1 })
    await store.put('u1', { priceId: 'p3', quantity: 1, addedAt: 1 })
    const listLineItems = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: 'li_1', price: { id: 'p1' }, quantity: 1 }],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [{ id: 'li_2', price: { id: 'p2' }, quantity: 1 }],
        has_more: false,
      })
    const stripe = {
      checkout: { sessions: { listLineItems } },
    } as unknown as Stripe
    const wc = { get: () => stripe } as never

    await cart.handlers['checkout.session.completed']?.(sessionEvent('payment', 'u1'), wc)
    expect(listLineItems).toHaveBeenCalledTimes(2)
    expect(listLineItems).toHaveBeenNthCalledWith(2, 'cs_1', {
      limit: 100,
      starting_after: 'li_1',
    })
    expect(await store.list('u1')).toEqual([{ priceId: 'p3', quantity: 1, addedAt: 1 }])
  })
})
