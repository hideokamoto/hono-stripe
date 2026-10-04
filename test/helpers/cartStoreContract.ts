import { describe, expect, it } from 'vitest'
import type { CartItem, CartStore } from '../../src/ec/types'

/**
 * CartStore contract suite — the adapter conformance layer of the test
 * pyramid (spec/quint/cart_ops.qnt). Every adapter — shipped or third-party —
 * must satisfy these semantics for the verified properties to carry over:
 *
 *  - mutations are pure put/delete of complete lines (no read-modify-write
 *    at the API level)
 *  - `list` enumerates EVERY line — a truncated enumeration silently
 *    corrupts checkout snapshots and drains (adapter obligation #2)
 *  - lines are keyed by priceId; put of an existing priceId is an absolute
 *    overwrite (last-writer-wins per key)
 *  - carts are isolated by cartId
 *  - a TTL'd store may drop expired lines — but expiry is store-side
 *    (noExpiryCharge boundary: bind TTL far above the checkout window)
 */
export const describeCartStoreContract = (
  name: string,
  makeStore: () => CartStore | Promise<CartStore>,
) => {
  const line = (priceId: string, quantity = 1, addedAt = 0): CartItem => ({
    priceId,
    quantity,
    addedAt,
  })

  describe(`CartStore contract — ${name}`, () => {
    it('put/list/delete round-trips lines', async () => {
      const store = await makeStore()
      await store.put('u1', line('p1', 2, 10))
      await store.put('u1', line('p2', 1, 20))
      const items = await store.list('u1')
      expect(items).toHaveLength(2)
      expect(items).toContainEqual(line('p1', 2, 10))
      expect(items).toContainEqual(line('p2', 1, 20))
      await store.delete('u1', 'p1')
      expect(await store.list('u1')).toEqual([line('p2', 1, 20)])
    })

    it('put is absolute — overwriting a priceId replaces quantity and addedAt', async () => {
      const store = await makeStore()
      await store.put('u1', line('p1', 1, 10))
      await store.put('u1', line('p1', 5, 30))
      expect(await store.list('u1')).toEqual([line('p1', 5, 30)])
    })

    it('delete of a missing key is a no-op', async () => {
      const store = await makeStore()
      await expect(store.delete('u1', 'ghost')).resolves.toBeUndefined()
      expect(await store.list('u1')).toEqual([])
    })

    it('list of an absent cart is empty, and carts are isolated', async () => {
      const store = await makeStore()
      await store.put('u1', line('p1'))
      expect(await store.list('u2')).toEqual([])
      expect(await store.list('u1')).toEqual([line('p1')])
    })

    it('list returns copies — mutating a returned item does not corrupt the store', async () => {
      const store = await makeStore()
      await store.put('u1', line('p1', 1, 10))
      const items = await store.list('u1')
      items[0]!.quantity = 999
      expect(await store.list('u1')).toEqual([line('p1', 1, 10)])
    })

    it('put does not read the existing line — no read-modify-write', async () => {
      const store = await makeStore()
      // A store that secretly RMWs would merge or fail here; absolute put
      // must simply overwrite whatever is there.
      await store.put('u1', line('p1', 1, 10))
      await store.put('u1', line('p1', 0, 20)) // quantity 0 is a legal put
      const items = await store.list('u1')
      expect(items).toEqual([line('p1', 0, 20)])
    })

    it('list enumerates every line — no truncation', async () => {
      const store = await makeStore()
      for (let i = 0; i < 25; i++) {
        await store.put('u1', line(`p${String(i).padStart(2, '0')}`, 1, i))
      }
      expect(await store.list('u1')).toHaveLength(25)
    })
  })
}
