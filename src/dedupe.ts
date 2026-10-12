/**
 * Deduplication of Stripe webhook deliveries.
 *
 * Stripe retries webhook delivery until it receives a 2xx response — for up to
 * ~3 days — and may also deliver the same event to multiple endpoints. Any
 * handler with side effects (billing state, emails, provisioning) should treat
 * delivery as at-least-once and ignore repeats of the same `event.id`.
 *
 * A {@link StripeEventStore} atomically claims an event id before the handler
 * runs, so concurrent deliveries of the same event cannot both execute it. The
 * claim is released if the handler throws or returns a non-2xx response, so a
 * failed delivery is retried normally.
 */

/**
 * Storage backend for processed Stripe event ids.
 *
 * `claim` MUST be atomic: of any number of concurrent callers claiming the same
 * id, exactly one gets `true` (a conditional insert, `SET NX`, a Durable
 * Object, a unique-key `INSERT`, …). Eventually consistent stores such as
 * Workers KV cannot provide this and are NOT suitable.
 *
 * `claim`/`release` errors are NOT swallowed by the router — a `claim` error
 * propagates as a 500 so Stripe retries the delivery (fail-closed). A store
 * that silently drops errors would double-process events, which is the worse
 * failure mode for payments.
 */
export interface StripeEventStore {
  /**
   * Atomically claim `eventId`. Resolves `true` if this caller acquired it,
   * `false` if it is already claimed (in flight or processed).
   * `ttlSeconds` is a hint for stores that support expiry.
   */
  claim(eventId: string, ttlSeconds: number): Promise<boolean>
  /**
   * Release a claim after the handler failed, so Stripe's retry can run it
   * again.
   */
  release(eventId: string): Promise<void>
}

export interface MemoryEventStoreOptions {
  /** Store capacity. Oldest entries are evicted when exceeded. Default: 1000. */
  maxEntries?: number
}

/**
 * In-memory event store — for development and single-isolate workloads.
 *
 * Atomic within one isolate/process only (claim is synchronous). Not suitable
 * for production on Workers (no cross-isolate coordination): implement
 * {@link StripeEventStore} on a store with atomic conditional writes — a
 * Durable Object, D1, or another database.
 */
export const memoryEventStore = (options: MemoryEventStoreOptions = {}): StripeEventStore => {
  const maxEntries = options.maxEntries ?? 1000
  // Map value = expiry epoch ms; insertion order lets us evict the oldest first.
  const seen = new Map<string, number>()
  return {
    claim: async (eventId, ttlSeconds) => {
      const expiry = seen.get(eventId)
      if (expiry !== undefined && expiry > Date.now()) return false
      seen.delete(eventId)
      seen.set(eventId, Date.now() + ttlSeconds * 1000)
      if (seen.size > maxEntries) {
        const oldest = seen.keys().next().value
        if (oldest !== undefined) seen.delete(oldest)
      }
      return true
    },
    release: async (eventId) => {
      seen.delete(eventId)
    },
  }
}
