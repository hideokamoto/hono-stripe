/**
 * Deduplication of Stripe webhook deliveries.
 *
 * Stripe retries webhook delivery until it receives a 2xx response — for up to
 * ~3 days — and may also deliver the same event to multiple endpoints. Any
 * handler with side effects (billing state, emails, provisioning) should treat
 * delivery as at-least-once and ignore repeats of the same `event.id`.
 *
 * A {@link StripeEventStore} records processed event ids. `stripeWebhook`
 * consults it before dispatching and records the id only when the handler
 * produced a 2xx-equivalent acknowledgement — a handler that throws or
 * returns a non-2xx `Response` leaves the event unrecorded, so Stripe's
 * retry re-runs it normally.
 */

/**
 * Storage backend for processed Stripe event ids.
 *
 * `has`/`put` errors are NOT swallowed by the router — they propagate as a 500
 * so Stripe retries the delivery (fail-closed). A store that silently drops
 * errors would double-process events, which is the worse failure mode for
 * payments.
 */
export interface StripeEventStore {
  /** Whether `eventId` has already been processed. */
  has(eventId: string): Promise<boolean>
  /** Record `eventId` as processed. `ttlSeconds` is a hint for stores that support expiry. */
  put(eventId: string, ttlSeconds: number): Promise<void>
}

export interface MemoryEventStoreOptions {
  /** Store capacity. Oldest entries are evicted when exceeded. Default: 1000. */
  maxEntries?: number
}

/**
 * In-memory event store — for development and single-isolate workloads.
 *
 * Not suitable for production on Workers (no cross-isolate durability): use
 * {@link kvEventStore} or your own database-backed {@link StripeEventStore}.
 */
export const memoryEventStore = (options: MemoryEventStoreOptions = {}): StripeEventStore => {
  const maxEntries = options.maxEntries ?? 1000
  // Map value = expiry epoch ms; insertion order lets us evict the oldest first.
  const seen = new Map<string, number>()
  return {
    has: async (eventId) => {
      const expiry = seen.get(eventId)
      if (expiry === undefined) return false
      if (expiry <= Date.now()) {
        seen.delete(eventId)
        return false
      }
      return true
    },
    put: async (eventId, ttlSeconds) => {
      seen.delete(eventId)
      seen.set(eventId, Date.now() + ttlSeconds * 1000)
      if (seen.size > maxEntries) {
        const oldest = seen.keys().next().value
        if (oldest !== undefined) seen.delete(oldest)
      }
    },
  }
}

/**
 * Minimal shape of a Cloudflare Workers KV namespace, declared structurally so
 * this module does not depend on `@cloudflare/workers-types`.
 */
export interface KVNamespaceLike {
  get(key: string): Promise<unknown>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

export interface KVEventStoreOptions {
  /** Key prefix inside the namespace. Default: `stripe:evt:`. */
  prefix?: string
}

/**
 * Cloudflare Workers KV-backed event store. KV's per-key `expirationTtl` handles
 * cleanup automatically.
 *
 * @example
 * ```ts
 * stripeWebhook({
 *   dedupe: kvEventStore(c.env.STRIPE_EVENTS), // KVNamespace binding
 *   on: { ... },
 * })
 * ```
 */
export const kvEventStore = (
  namespace: KVNamespaceLike,
  options: KVEventStoreOptions = {},
): StripeEventStore => {
  const prefix = options.prefix ?? 'stripe:evt:'
  return {
    has: async (eventId) => (await namespace.get(`${prefix}${eventId}`)) !== null,
    put: async (eventId, ttlSeconds) => {
      await namespace.put(`${prefix}${eventId}`, '1', { expirationTtl: ttlSeconds })
    },
  }
}
