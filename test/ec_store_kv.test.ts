import { describe, expect, it } from 'vitest'
import { describeCartStoreContract } from './helpers/cartStoreContract'
import { fakeKV } from './helpers/fakeKV'
import { kvCartStore } from '../src/ec/store/kv'
import { memoryCartStore } from '../src/ec/store/memory'

describeCartStoreContract('memory adapter', () => memoryCartStore())

describeCartStoreContract('kv adapter', () => kvCartStore(fakeKV()))

describe('kvCartStore — KV-specific behaviors', () => {
  it('list paginates through every page — no truncation at the page cap', async () => {
    // Real KV caps at 1000 keys/page; pageSize 3 forces multi-page carts.
    const kv = fakeKV({ pageSize: 3 })
    const store = kvCartStore(kv)
    for (let i = 0; i < 7; i++) {
      await store.put('u1', { priceId: `p${i}`, quantity: 1, addedAt: i })
    }
    const items = await store.list('u1')
    expect(items).toHaveLength(7)
  })

  it('honors expirationTtl — expired lines drop out of list', async () => {
    const kv = fakeKV()
    const store = kvCartStore(kv, { ttlSeconds: 60 })
    await store.put('u1', { priceId: 'p1', quantity: 1, addedAt: 0 })
    expect(await store.list('u1')).toHaveLength(1)
    kv.advance(61_000)
    // spec: noExpiryCharge — expiry is a documented boundary; TTL must be
    // bound far above the checkout window. The store only guarantees that
    // expired lines are gone from list.
    expect(await store.list('u1')).toEqual([])
  })

  it('omits expirationTtl when ttlSeconds is not configured', async () => {
    const kv = fakeKV()
    const store = kvCartStore(kv)
    await store.put('u1', { priceId: 'p1', quantity: 1, addedAt: 0 })
    const entry = [...kv._entries.values()][0]!
    expect(entry.expiresAt).toBeUndefined()
  })

  it('reads lines written without metadata via get() fallback', async () => {
    const kv = fakeKV()
    const store = kvCartStore(kv)
    // Simulate a key written by another writer without metadata.
    await kv.put(
      'cart:u1:item:p1',
      JSON.stringify({ priceId: 'p1', quantity: 4, addedAt: 7 }),
    )
    expect(await store.list('u1')).toEqual([
      { priceId: 'p1', quantity: 4, addedAt: 7 },
    ])
  })

  it('scopes keys under keyPrefix when configured', async () => {
    const kv = fakeKV()
    const store = kvCartStore(kv, { keyPrefix: 'shop:' })
    await store.put('u1', { priceId: 'p1', quantity: 1, addedAt: 0 })
    expect(kv._entries.has('shop:cart:u1:item:p1')).toBe(true)
    // A cart under a different prefix is invisible.
    await kv.put(
      'cart:u1:item:p2',
      JSON.stringify({ priceId: 'p2', quantity: 9, addedAt: 0 }),
    )
    expect(await store.list('u1')).toEqual([
      { priceId: 'p1', quantity: 1, addedAt: 0 },
    ])
  })

  it('skips malformed values instead of throwing', async () => {
    const kv = fakeKV()
    const store = kvCartStore(kv)
    await store.put('u1', { priceId: 'p1', quantity: 1, addedAt: 0 })
    await kv.put('cart:u1:item:broken', 'not-json{{{')
    expect(await store.list('u1')).toEqual([
      { priceId: 'p1', quantity: 1, addedAt: 0 },
    ])
  })
})
