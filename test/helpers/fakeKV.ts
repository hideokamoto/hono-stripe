/**
 * Fake Workers KV namespace for unit tests.
 *
 * Models the KVNamespace surface `CartKVNamespace` relies on — including the
 * two behaviors that make a naive adapter wrong:
 *  - `list` paginates (real KV caps at 1000 keys/page; pageSize here is
 *    configurable so tests force multi-page lists with tiny carts)
 *  - `expirationTtl` expires keys lazily against an injectable clock
 *
 * NOT a weak-consistency simulator — this store is strongly consistent.
 * Weak-store semantics (lagging view) live in StagedCartStore in
 * ec_vectors.test.ts, which mirrors spec/quint/cart_ops.qnt's truth/view
 * split.
 */

export interface FakeKVEntry {
  value: string
  metadata?: unknown
  expiresAt?: number // epoch ms
}

export const fakeKV = (options: { pageSize?: number } = {}) => {
  const pageSize = options.pageSize ?? 1000
  const entries = new Map<string, FakeKVEntry>()
  let nowMs = Date.now()

  const live = (key: string): boolean => {
    const e = entries.get(key)
    return e !== undefined && (e.expiresAt === undefined || e.expiresAt > nowMs)
  }

  const sortedLiveKeys = (prefix: string): string[] =>
    [...entries.keys()].filter((k) => k.startsWith(prefix) && live(k)).sort()

  return {
    /** Advance the clock — expires keys whose TTL has elapsed. */
    advance: (ms: number) => {
      nowMs += ms
    },
    get: async (key: string): Promise<string | null> =>
      live(key) ? (entries.get(key)?.value ?? null) : null,
    put: async (
      key: string,
      value: string,
      opts?: { expirationTtl?: number; metadata?: unknown },
    ): Promise<void> => {
      entries.set(key, {
        value,
        metadata: opts?.metadata,
        expiresAt: opts?.expirationTtl
          ? nowMs + opts.expirationTtl * 1000
          : undefined,
      })
    },
    delete: async (key: string): Promise<void> => {
      entries.delete(key)
    },
    list: async (opts?: {
      prefix?: string
      cursor?: string
      limit?: number
    }): Promise<{
      keys: { name: string; metadata?: unknown }[]
      list_complete: boolean
      cursor?: string
    }> => {
      const keys = sortedLiveKeys(opts?.prefix ?? '')
      const start = opts?.cursor ? Number.parseInt(opts.cursor, 10) : 0
      const limit = opts?.limit ?? pageSize
      const page = keys.slice(start, start + limit)
      const complete = start + limit >= keys.length
      return {
        keys: page.map((name) => ({
          name,
          metadata: entries.get(name)?.metadata,
        })),
        list_complete: complete,
        cursor: complete ? undefined : String(start + limit),
      }
    },
    /** Test introspection: raw entries map. */
    _entries: entries,
  }
}

export type FakeKVNamespace = ReturnType<typeof fakeKV>
