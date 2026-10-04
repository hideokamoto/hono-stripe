import { describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { stripeCart } from '../src/ec/index'
import { memoryCartStore } from '../src/ec/store/memory'
import type { CartCheckoutLineItem } from '../src/ec/types'

/**
 * onDrained — the fulfillment handoff.
 *
 * spec/quint/cart_ops.qnt `fulfilledExactlyCharged`: the callback must
 * receive exactly the charged snapshot — the session's line items — never
 * a re-enumerated cart list. A re-enumeration could ship uncharged lines
 * (post-snapshot adds) or miss stale keys; the session IS the charge
 * record (spec/alloy/cart_link.als `FulfillmentDrift`).
 */

const c = {} as never

const sessionEvent = (mode: string, refId: string | null) =>
  ({
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', mode, client_reference_id: refId } },
  }) as unknown as Stripe.CheckoutSessionCompletedEvent

const stripeWith = (listLineItems: ReturnType<typeof vi.fn>) =>
  ({ checkout: { sessions: { listLineItems } } }) as unknown as Stripe

const wc = (stripe: Stripe) => ({ get: () => stripe }) as never

const oneItemPage = (priceId: string, quantity = 1) =>
  vi.fn().mockResolvedValue({
    data: [{ price: { id: priceId }, quantity }],
    has_more: false,
  })

describe('stripeCart — onDrained (fulfilledExactlyCharged)', () => {
  it('passes the charged snapshot to the callback after draining', async () => {
    const store = memoryCartStore()
    const onDrained = vi.fn()
    const cart = stripeCart({
      store,
      user: () => 'u1',
      onDrained,
    })
    await store.put('u1', { priceId: 'p1', quantity: 2, addedAt: 1 })
    await store.put('u1', { priceId: 'p2', quantity: 1, addedAt: 1 })
    const stripe = stripeWith(
      vi.fn().mockResolvedValue({
        data: [
          { price: { id: 'p1' }, quantity: 2 },
          { price: { id: 'p2' }, quantity: 1 },
        ],
        has_more: false,
      }),
    )

    await cart.handlers['checkout.session.completed']?.(
      sessionEvent('payment', 'u1'),
      wc(stripe),
    )
    expect(onDrained).toHaveBeenCalledTimes(1)
    expect(onDrained).toHaveBeenCalledWith({
      c: expect.anything(),
      cartId: 'u1',
      items: [
        { price: 'p1', quantity: 2 },
        { price: 'p2', quantity: 1 },
      ] satisfies CartCheckoutLineItem[],
    })
  })

  it('delivers the snapshot, not the cart — post-snapshot adds are not fulfilled', async () => {
    const store = memoryCartStore()
    const onDrained = vi.fn()
    const cart = stripeCart({ store, user: () => 'u1', onDrained })
    await store.put('u1', { priceId: 'p1', quantity: 1, addedAt: 1 })
    // User adds p3 while checkout is in-flight — survives in the cart
    // (deletesOnlySnapshotted) but must NOT be fulfilled: it was not charged.
    await store.put('u1', { priceId: 'p3', quantity: 1, addedAt: 2 })
    const stripe = stripeWith(oneItemPage('p1'))

    await cart.handlers['checkout.session.completed']?.(
      sessionEvent('payment', 'u1'),
      wc(stripe),
    )
    expect(onDrained).toHaveBeenCalledWith(
      expect.objectContaining({
        cartId: 'u1',
        items: [{ price: 'p1', quantity: 1 }],
      }),
    )
    expect(await store.list('u1')).toEqual([
      { priceId: 'p3', quantity: 1, addedAt: 2 },
    ])
  })

  it('collects items across listLineItems pages and calls back once', async () => {
    const store = memoryCartStore()
    const onDrained = vi.fn()
    const cart = stripeCart({ store, user: () => 'u1', onDrained })
    const listLineItems = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: 'li_1', price: { id: 'p1' }, quantity: 1 }],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [
          { id: 'li_2', price: { id: 'p2' }, quantity: 3 },
          { id: 'li_3', price: { id: 'p3' }, quantity: 1 },
        ],
        has_more: false,
      })

    await cart.handlers['checkout.session.completed']?.(
      sessionEvent('payment', 'u1'),
      wc(stripeWith(listLineItems)),
    )
    expect(onDrained).toHaveBeenCalledTimes(1)
    expect(onDrained).toHaveBeenCalledWith(
      expect.objectContaining({
        cartId: 'u1',
        items: [
          { price: 'p1', quantity: 1 },
          { price: 'p2', quantity: 3 },
          { price: 'p3', quantity: 1 },
        ],
      }),
    )
  })

  it('is not invoked for non-payment sessions or missing client_reference_id', async () => {
    const onDrained = vi.fn()
    const cart = stripeCart({
      store: memoryCartStore(),
      user: () => 'u1',
      onDrained,
    })
    const stripe = stripeWith(oneItemPage('p1'))
    const ctx = wc(stripe)

    await cart.handlers['checkout.session.completed']?.(
      sessionEvent('subscription', 'u1'),
      ctx,
    )
    await cart.handlers['checkout.session.completed']?.(
      sessionEvent('payment', null),
      ctx,
    )
    expect(onDrained).not.toHaveBeenCalled()
    expect(stripe.checkout.sessions.listLineItems).not.toHaveBeenCalled()
  })

  it('a throwing callback propagates — fulfillment failure must retry, not ack', async () => {
    const store = memoryCartStore()
    const cart = stripeCart({
      store,
      user: () => 'u1',
      onDrained: () => {
        throw new Error('fulfillment backend down')
      },
    })
    await store.put('u1', { priceId: 'p1', quantity: 1, addedAt: 1 })
    const stripe = stripeWith(oneItemPage('p1'))

    await expect(
      cart.handlers['checkout.session.completed']?.(
        sessionEvent('payment', 'u1'),
        wc(stripe),
      ),
    ).rejects.toThrow('fulfillment backend down')
  })

  it('direct drain() does not invoke the callback — it is a webhook-level hook', async () => {
    const store = memoryCartStore()
    const onDrained = vi.fn()
    const cart = stripeCart({ store, user: () => 'u1', onDrained })
    await store.put('u1', { priceId: 'p1', quantity: 1, addedAt: 1 })
    await cart.drain(c, ['p1'])
    expect(onDrained).not.toHaveBeenCalled()
  })

  it('is optional — handlers work without it', async () => {
    const store = memoryCartStore()
    const cart = stripeCart({ store, user: () => 'u1' })
    await store.put('u1', { priceId: 'p1', quantity: 1, addedAt: 1 })
    const stripe = stripeWith(oneItemPage('p1'))
    await expect(
      cart.handlers['checkout.session.completed']?.(
        sessionEvent('payment', 'u1'),
        wc(stripe),
      ),
    ).resolves.toBeUndefined()
  })
})
