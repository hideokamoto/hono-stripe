import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stripeCart } from '../src/ec/index'
import type { CartItem, CartStore } from '../src/ec/types'

/**
 * Spec-vector replay tests — the top of the unit-test pyramid.
 *
 * Every fixture in test/fixtures/ec/ is an action schedule extracted from a
 * Quint MBT trace of spec/quint/cart_ops.qnt, including the schedules that
 * produce the documented-boundary counterexamples (stale charge, lost
 * post-snapshot re-add, expiry charge). Replaying them through the real
 * stripeCart on a staged weak-store proves the implementation reproduces
 * the model's semantics — flags and all.
 *
 * Regenerate with:
 *   quint run spec/quint/cart_ops.qnt --mbt \
 *     --out-itf=/tmp/carttraces/t_{#}.itf.json --n-traces=3000 --max-steps=15
 *   node spec/tools/itf2cartvector.mjs /tmp/carttraces test/fixtures/ec
 */

interface Vector {
  name: string
  events: { op: string; it?: string; qty?: number }[]
  final: {
    truth: Record<string, number>
    view: Record<string, number>
    charged: string[][]
    expired: string[]
    lostPostSnapWrites: string[]
    staleCharge: boolean
  }
}

const vectors: Vector[] = readdirSync(join(__dirname, 'fixtures/ec'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(__dirname, 'fixtures/ec', f), 'utf8')))

/**
 * Weak-store simulation of spec/quint/cart_ops.qnt's truth/view split.
 *
 * Client writes land in `truth` immediately; `view` (what list serves) only
 * catches up on `applyWrites` — the store edge propagating pending writes.
 * `expire` is a store-side TTL delete joining the pending set (lags like a
 * normal delete). `expelView` removes keys from view only — the checkout
 * commit's atomic drain (model removes snapshotted keys from both maps).
 */
const stagedCartStore = () => {
  const truth = new Map<string, CartItem>()
  const view = new Map<string, CartItem>()
  const expired = new Set<string>()
  const store: CartStore & {
    applyWrites: () => void
    expire: (priceId: string) => void
    expelView: (priceIds: string[]) => void
    _truth: Map<string, CartItem>
    _view: Map<string, CartItem>
    _expired: Set<string>
  } = {
    list: async () => [...view.values()].map((i) => ({ ...i })),
    put: async (_cartId, item) => {
      truth.set(item.priceId, { ...item })
    },
    delete: async (_cartId, priceId) => {
      truth.delete(priceId)
    },
    applyWrites: () => {
      view.clear()
      for (const [k, v] of truth) view.set(k, { ...v })
    },
    expire: (priceId) => {
      if (truth.has(priceId)) {
        truth.delete(priceId)
        expired.add(priceId)
      }
    },
    expelView: (priceIds) => {
      for (const k of priceIds) view.delete(k)
    },
    _truth: truth,
    _view: view,
    _expired: expired,
  }
  return store
}

const c = {} as never

const qtyMap = (m: Map<string, CartItem>) =>
  Object.fromEntries([...m.values()].map((i) => [i.priceId, i.quantity]))

const nonzero = (m: Record<string, number>) =>
  Object.fromEntries(Object.entries(m).filter(([, q]) => q > 0))

describe('spec-vector replay — cart_ops.qnt schedules', () => {
  it.each(vectors.map((v) => [v.name, v] as const))(
    '%s replays to the model end state',
    async (_name, vector) => {
      const store = stagedCartStore()
      const cart = stripeCart({ store, user: () => 'u1' })

      // Harness-side mirrors of the model's tracking vars.
      const charged: string[][] = []
      const postSnapWrites = new Set<string>()
      const lostPostSnapWrites = new Set<string>()
      let staleCharge = false
      let snapshot: string[] | null = null
      let staleKeys: string[] = []

      for (const ev of vector.events) {
        switch (ev.op) {
          case 'setItem':
            await cart.set(c, ev.it!, ev.qty!)
            if (snapshot !== null) postSnapWrites.add(ev.it!)
            break
          case 'removeItem':
            await cart.remove(c, ev.it!)
            postSnapWrites.delete(ev.it!)
            break
          case 'applyWrites':
            store.applyWrites()
            break
          case 'expireLine':
            store.expire(ev.it!)
            break
          case 'checkoutSnap': {
            // The model allows an empty snapshot; the impl refuses empty
            // carts — record null so commit is a no-op either way.
            const viewNow = await cart.items(c)
            staleKeys = viewNow
              .filter((i) => !store._truth.has(i.priceId))
              .map((i) => i.priceId)
            snapshot = viewNow.length
              ? (await cart.checkout(c)).params.line_items.map((l) => l.price)
              : null
            postSnapWrites.clear()
            break
          }
          case 'checkoutCommit': {
            if (snapshot !== null) {
              if (staleKeys.some((k) => snapshot!.includes(k))) staleCharge = true
              await cart.drain(c, snapshot)
              store.expelView(snapshot)
              charged.push(snapshot)
              for (const k of postSnapWrites) {
                if (snapshot.includes(k)) lostPostSnapWrites.add(k)
              }
            }
            snapshot = null
            staleKeys = []
            postSnapWrites.clear()
            break
          }
        }
      }

      // End-state equality: the implementation reproduces the model's
      // truth, served view, charged snapshots, and boundary flags.
      expect(qtyMap(store._truth)).toEqual(nonzero(vector.final.truth))
      expect(qtyMap(store._view)).toEqual(nonzero(vector.final.view))
      // charged is a Quint Set — compare as a set (sort inner and outer;
      // ITF ordering is not commit order).
      const normSets = (sets: string[][]) =>
        sets
          .filter((s) => s.length > 0)
          .map((s) => [...s].sort())
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      expect(normSets(charged)).toEqual(normSets(vector.final.charged))
      expect([...lostPostSnapWrites].sort()).toEqual(
        [...vector.final.lostPostSnapWrites].sort(),
      )
      expect(staleCharge).toBe(vector.final.staleCharge)
      // Expiry charge: model semantics — a key counts if it appears in ANY
      // charged snapshot and in the expired set (charge-then-expire counts
      // too, matching the model's set intersection).
      expect(
        charged.flat().filter((k) => store._expired.has(k)).sort(),
      ).toEqual(
        vector.final.charged
          .flat()
          .filter((k) => vector.final.expired.includes(k))
          .sort(),
      )
    },
  )
})
