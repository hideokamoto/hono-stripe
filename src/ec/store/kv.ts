import type { CartItem, CartStore } from '../types'

/**
 * Minimal KV surface a `kvCartStore` needs — structurally compatible with
 * Cloudflare's `KVNamespace` (a real binding is a superset of this).
 */
export interface CartKVNamespace {
  get(key: string): Promise<string | null>
  put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number; metadata?: unknown },
  ): Promise<void>
  delete(key: string): Promise<void>
  list(opts?: {
    prefix?: string
    cursor?: string
    limit?: number
  }): Promise<{
    keys: { name: string; metadata?: unknown }[]
    list_complete: boolean
    cursor?: string
  }>
}

export interface KvCartStoreOptions {
  /**
   * Namespace prefix for cart keys. Default: none — keys look like
   * `cart:{cartId}:item:{priceId}`.
   */
  keyPrefix?: string
  /**
   * Per-line `expirationTtl` (seconds) — how long an untouched line lives.
   * Cleans up abandoned carts for free.
   *
   * Boundary (spec `noExpiryCharge`): an expired line can still be charged
   * if it was visible at snapshot time. Bind TTL far above the checkout
   * completion window — checkout sessions complete in minutes, so think
   * hours-to-days, never minutes.
   */
  ttlSeconds?: number
}

const itemKey = (prefix: string, cartId: string, priceId: string) =>
  `${prefix}cart:${cartId}:item:${priceId}`

const cartPrefix = (prefix: string, cartId: string) =>
  `${prefix}cart:${cartId}:item:`

const isCartItem = (v: unknown): v is CartItem =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as CartItem).priceId === 'string' &&
  typeof (v as CartItem).quantity === 'number' &&
  typeof (v as CartItem).addedAt === 'number'

/**
 * Workers KV adapter for {@link CartStore} — the store the ec layer is
 * designed around (spec/quint/cart_ops.qnt).
 *
 * Layout: one KV key per cart line, `cart:{id}:item:{priceId}`, so every
 * mutation is a pure `put`/`delete` — never read-modify-write, as the
 * contract requires.
 *
 * The full `CartItem` is duplicated into KV metadata on write, so `list`
 * reads lines without a `get` per key. Keys lacking metadata (written by
 * another writer) fall back to `get`.
 *
 * `list` paginates through EVERY page — a truncated enumeration would
 * silently corrupt checkout snapshots and drains (adapter obligation).
 * KV's eventual consistency is the model's `view` lag: list may serve a
 * stale view; see the stale-charge hazard on `CartStore`.
 */
export const kvCartStore = (
  kv: CartKVNamespace,
  options: KvCartStoreOptions = {},
): CartStore => {
  const prefix = options.keyPrefix ?? ''

  const readKey = async (name: string, metadata: unknown): Promise<CartItem | null> => {
    if (isCartItem(metadata)) return { ...metadata }
    const raw = await kv.get(name)
    if (raw === null) return null
    try {
      const parsed: unknown = JSON.parse(raw)
      return isCartItem(parsed) ? { ...parsed } : null
    } catch {
      return null
    }
  }

  return {
    list: async (cartId) => {
      const items: CartItem[] = []
      let cursor: string | undefined
      // Page through the whole enumeration — stopping early would drop
      // lines from the checkout snapshot and from drain.
      do {
        const page = await kv.list({
          prefix: cartPrefix(prefix, cartId),
          cursor,
          limit: 1000,
        })
        for (const key of page.keys) {
          const item = await readKey(key.name, key.metadata)
          if (item) items.push(item)
        }
        cursor = page.list_complete ? undefined : page.cursor
      } while (cursor)
      return items
    },
    put: async (cartId, item) => {
      await kv.put(itemKey(prefix, cartId, item.priceId), JSON.stringify(item), {
        expirationTtl: options.ttlSeconds,
        metadata: item,
      })
    },
    delete: async (cartId, priceId) => {
      await kv.delete(itemKey(prefix, cartId, priceId))
    },
  }
}
