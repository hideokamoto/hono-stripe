import { beforeEach, describe, expect, it } from 'vitest'
import { __cacheSize, __resetCaches, getStripeClient, type StripeClientConfig } from '../src/runtime'
import type { StripeMiddlewareOptions } from '../src/types'

const KEY = 'sk_test_123'

type HttpClient = NonNullable<StripeClientConfig['httpClient']>

// A distinct dummy httpClient. Its methods are dropped by JSON.stringify, so two
// instances serialize to the same string ("{}") — exactly the collision the old
// cache key fell into.
const dummyHttpClient = (): HttpClient =>
  ({
    getClientName: () => 'dummy',
    makeRequest: () => Promise.reject(new Error('not implemented')),
  }) as unknown as HttpClient

beforeEach(() => __resetCaches())

describe('getStripeClient cache keying', () => {
  it('returns distinct clients for the same key but different config.httpClient', () => {
    const optionsA: StripeMiddlewareOptions = { config: { httpClient: dummyHttpClient() } }
    const optionsB: StripeMiddlewareOptions = { config: { httpClient: dummyHttpClient() } }

    const a = getStripeClient(KEY, optionsA)
    const b = getStripeClient(KEY, optionsB)

    expect(a).not.toBe(b)
  })

  it('returns the same cached client for the same options object', () => {
    const options: StripeMiddlewareOptions = { config: { httpClient: dummyHttpClient() } }
    const first = getStripeClient(KEY, options)
    const second = getStripeClient(KEY, options)
    expect(first).toBe(second)
  })

  it('still caches for equivalent serializable options', () => {
    const a = getStripeClient(KEY, {})
    const b = getStripeClient(KEY, {})
    expect(a).toBe(b)
  })

  it('does not throw when called without options (untyped JS caller)', () => {
    // TypeScript's type system prevents this at compile time, but a JS caller
    // (no type checking) can still omit `options` or pass `null`. The WeakMap
    // used internally throws on a non-object key, so this must not reach it.
    expect(() => getStripeClient(KEY, undefined as unknown as StripeMiddlewareOptions)).not.toThrow()
    expect(() => getStripeClient(KEY, null as unknown as StripeMiddlewareOptions)).not.toThrow()
  })
})

describe('getStripeClient cache eviction', () => {
  it('does not grow past the cap when many distinct keys are inserted', () => {
    const cap = 100
    const overflow = 25
    for (let i = 0; i < cap + overflow; i++) {
      getStripeClient(`sk_test_${i}`, {})
    }
    expect(__cacheSize()).toBeLessThanOrEqual(cap)
  })

  it('evicts the oldest entry once the cap is exceeded', () => {
    const cap = 100
    const first = getStripeClient('sk_test_first', {})
    // Fill the remaining slots plus one, evicting the oldest (first) entry.
    for (let i = 0; i < cap; i++) {
      getStripeClient(`sk_test_${i}`, {})
    }
    // The first entry should have been evicted, so a fresh client is built.
    const firstAgain = getStripeClient('sk_test_first', {})
    expect(firstAgain).not.toBe(first)
  })
})
