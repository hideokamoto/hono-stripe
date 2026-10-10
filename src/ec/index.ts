import type { Context } from 'hono'
import type Stripe from 'stripe'
import type { StripeWebhookHandlers } from '../webhooks'
import type {
  CartCheckout,
  CartCheckoutLineItem,
  CartCheckoutOptions,
  CartItem,
  CartStore,
  CartStoreResolver,
} from './types'
import { resolveCartStore } from './types'

export interface StripeCartOptions {
  /**
   * Where cart lines live. Must satisfy the `CartStore` contract — pure
   * put/delete, no read-modify-write (spec/quint/cart_ops.qnt). Pass a
   * function to resolve a store per request (Workers bindings).
   */
  store: CartStoreResolver
  /**
   * Resolve the cart owner id per request — a user id or an anonymous
   * session id. Every cart operation is scoped to its owner. The resolved
   * id is also stamped as `client_reference_id` on checkout sessions so
   * the owner round-trips through Stripe (Alloy `cart_link.als`:
   * OrphanCheckout).
   */
  user: (c: Context) => string | Promise<string>
  /**
   * Fulfillment handoff — invoked after each drained payment session's
   * drain completes, with the session's line items.
   *
   * Contract (spec `fulfilledExactlyCharged`): `items` is the charged
   * snapshot itself — the session's `line_items` — never a re-enumeration
   * of the cart. A post-snapshot add survives in the cart but is not in
   * `items` (it was not charged).
   *
   * Delivery is at-least-once: throwing propagates as a 500 so Stripe
   * retries the delivery — a fulfillment failure must never be
   * acknowledged — and a lost 200 can also produce a redelivery. Make the
   * callback idempotent, keyed on `sessionId`.
   */
  onDrained?: (args: {
    c: Context
    sessionId: string
    cartId: string
    items: CartCheckoutLineItem[]
  }) => void | Promise<void>
}

export interface StripeCart {
  /**
   * The cart's visible lines — may lag recent writes on weak stores
   * (the `view` vs `truth` gap in spec/quint/cart_ops.qnt).
   */
  items: (c: Context) => Promise<CartItem[]>
  /**
   * Absolute quantity set — a pure put, never read-modify-write
   * (spec: `setItem`). `quantity <= 0` removes the line.
   */
  set: (c: Context, priceId: string, quantity: number) => Promise<void>
  /** Pure delete of one line (spec: `removeItem`). */
  remove: (c: Context, priceId: string) => Promise<void>
  /** Enumerate + delete every visible line — still no read-modify-write. */
  clear: (c: Context) => Promise<void>
  /**
   * Fold another cart (e.g. an anonymous session cart) into the current
   * request's cart — the login merge required by Alloy `TwoCartsOneUser`.
   * On a shared priceId the line with the newer `addedAt` wins; a tie goes
   * to the source (`MergeConflict`). The source cart is cleared.
   *
   * Boundary (same class as the stale-charge hazard): a write landing on
   * the source cart between the enumerate and the delete is neither merged
   * nor removed — it is stranded on an abandoned cart id. Merging is a
   * login-time operation; quiescent carts make this vanishingly rare.
   */
  merge: (c: Context, fromCartId: string) => Promise<{ merged: number }>
  /**
   * Snapshot the visible lines into Stripe Checkout params
   * (`mode: 'payment'`). Throws on an empty cart (Alloy: EmptyCheckout)
   * and on an unresolvable cart owner — a session without
   * `client_reference_id` could charge but never drain (OrphanCheckout).
   * The cart id is stamped as `client_reference_id` so the session
   * resolves to its owner and `handlers` can drain the right cart on
   * completion.
   */
  checkout: (c: Context, options?: CartCheckoutOptions) => Promise<CartCheckout>
  /**
   * Delete exactly the snapshotted price ids — post-snapshot adds on OTHER
   * priceIds survive (spec: `deletesOnlySnapshotted`). Idempotent.
   *
   * Boundary (spec `noPostSnapWriteLoss`): a line re-added while its
   * checkout was in-flight shares the snapshotted priceId and is deleted
   * too — drain cannot tell it apart from the snapshotted line.
   *
   * Normally invoked by `handlers` on `checkout.session.completed`; call
   * directly only when wiring your own webhook in request context.
   */
  drain: (c: Context, priceIds: string[]) => Promise<void>
  /**
   * Typed handlers to merge into `stripeWebhook({ on: ... })` — drains the
   * snapshotted keys on `checkout.session.completed` for `mode: 'payment'`
   * sessions, taking the cart id from `client_reference_id`.
   */
  handlers: StripeWebhookHandlers
}

export const stripeCart = (options: StripeCartOptions): StripeCart => {
  const storeOf = (c: Context): CartStore => resolveCartStore(options.store, c)
  const cartIdOf = (c: Context): Promise<string> => Promise.resolve(options.user(c))
  const addedAtNow = () => Math.floor(Date.now() / 1000)

  const handlers: StripeWebhookHandlers = {
    'checkout.session.completed': async (event, c) => {
      const session = event.data.object
      if (session.mode !== 'payment') return
      const cartId = session.client_reference_id
      if (!cartId) return
      const stripe = c.get('stripe') as Stripe | undefined
      if (!stripe) {
        throw new Error('hono-stripe/ec: no Stripe client on context.')
      }
      const store = storeOf(c)
      // Paginate the whole snapshot — a truncated drain would ack the event
      // and leave the overflow lines in the cart permanently.
      const drained: CartCheckoutLineItem[] = []
      let startingAfter: string | undefined
      do {
        const page = await stripe.checkout.sessions.listLineItems(session.id, {
          limit: 100,
          starting_after: startingAfter,
        })
        for (const item of page.data) {
          const priceId = item.price?.id
          if (priceId) {
            await store.delete(cartId, priceId)
            drained.push({ price: priceId, quantity: item.quantity ?? 1 })
          }
        }
        startingAfter = page.has_more ? page.data[page.data.length - 1]?.id : undefined
      } while (startingAfter)
      // fulfilledExactlyCharged: hand fulfillment the session's line items
      // — the charged snapshot — never a re-enumerated cart list.
      await options.onDrained?.({ c, sessionId: session.id, cartId, items: drained })
    },
  }

  // The spec model defines membership as quantity > 0 — a corrupt or
  // foreign-written non-positive line is not a cart item and must not reach
  // checkout (Stripe rejects line_items with quantity < 1).
  const live = (items: CartItem[]) => items.filter((i) => i.quantity > 0)

  return {
    items: async (c) => live(await storeOf(c).list(await cartIdOf(c))),

    set: async (c, priceId, quantity) => {
      const store = storeOf(c)
      const cartId = await cartIdOf(c)
      if (quantity <= 0) {
        await store.delete(cartId, priceId)
        return
      }
      await store.put(cartId, { priceId, quantity, addedAt: addedAtNow() })
    },

    remove: async (c, priceId) => storeOf(c).delete(await cartIdOf(c), priceId),

    clear: async (c) => {
      const store = storeOf(c)
      const cartId = await cartIdOf(c)
      for (const line of await store.list(cartId)) {
        await store.delete(cartId, line.priceId)
      }
    },

    merge: async (c, fromCartId) => {
      const store = storeOf(c)
      const cartId = await cartIdOf(c)
      if (fromCartId === cartId) return { merged: 0 }
      const [from, to] = await Promise.all([
        store.list(fromCartId).then(live),
        store.list(cartId).then(live),
      ])
      const targetByPrice = new Map(to.map((i) => [i.priceId, i]))
      let merged = 0
      for (const line of from) {
        const existing = targetByPrice.get(line.priceId)
        if (!existing || line.addedAt >= existing.addedAt) {
          await store.put(cartId, line)
          merged++
        }
      }
      for (const line of from) {
        await store.delete(fromCartId, line.priceId)
      }
      return { merged }
    },

    checkout: async (c, checkoutOptions) => {
      const store = storeOf(c)
      const cartId = await cartIdOf(c)
      if (!cartId) {
        throw new Error(
          'hono-stripe/ec: no cart owner id resolved — refusing checkout (the session could charge but never drain).',
        )
      }
      const lines = live(await store.list(cartId))
      if (lines.length === 0) {
        throw new Error('hono-stripe/ec: refusing checkout on an empty cart')
      }
      return {
        items: lines,
        params: {
          // Caller extras merge first; the structural fields below are
          // always generated by the cart — overriding them would break the
          // invariants checkout relies on (OrphanCheckout, drain's mode
          // filter).
          ...checkoutOptions?.params,
          mode: 'payment',
          line_items: lines.map((l) => ({ price: l.priceId, quantity: l.quantity })),
          client_reference_id: cartId,
        },
      }
    },

    // Boundary (spec `noPostSnapWriteLoss`): drain deletes by priceId, so a
    // line re-ADDED while its checkout was in-flight is deleted too — the
    // store cannot tell it apart from the snapshotted line. Adds on other
    // priceIds always survive.
    drain: async (c, priceIds) => {
      const store = storeOf(c)
      const cartId = await cartIdOf(c)
      for (const priceId of priceIds) {
        await store.delete(cartId, priceId)
      }
    },

    handlers,
  }
}

export type {
  CartCheckout,
  CartCheckoutLineItem,
  CartCheckoutOptions,
  CartCheckoutParams,
  CartItem,
  CartStore,
  CartStoreResolver,
} from './types'
export { resolveCartStore } from './types'
export { memoryCartStore } from './store/memory'
export { kvCartStore } from './store/kv'
export type { CartKVNamespace, KvCartStoreOptions } from './store/kv'
