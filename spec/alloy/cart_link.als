/*
 * cart_link.als — relational model for hono-stripe/ec.
 *
 * Same role billing_link.als played for the billing layer: surface the
 * invariants that CANNOT be delegated to the store layout and must live
 * in application logic. SAT scenarios below are the documented failure
 * shapes the ec design has to handle.
 */

sig User {}
sig AnonSession {}

abstract sig PriceKind {}
one sig OneTime, Recurring extends PriceKind {}

sig Price {
  kind: one PriceKind
}

sig Cart {
  owner: one (User + AnonSession),
  items: Item -> one Int
}

sig Item {
  priceId: one Price
}

abstract sig SessionMode {}
one sig Payment, Subscription extends SessionMode {}

sig CheckoutSession {
  items: Item -> one Int,   -- snapshot taken at checkout time
  user: lone User,          -- resolvable owner at charge time
  cart: lone Cart,          -- cart this session drained
  mode: one SessionMode     -- ec only ever emits mode: 'payment'
}

sig Fulfillment {
  of: one CheckoutSession,
  items: Item -> one Int    -- what was actually shipped/provisioned
}

-- The same person ends up with TWO carts (anon cart + user cart) unless
-- login merges them — nothing structural prevents it.
pred TwoCartsOneUser {
  some disj c1, c2: Cart | c1.owner = c2.owner
}
run TwoCartsOneUser for 3 but 2 Cart

-- Anon browses, logs in, checks out: the charge must resolve to the USER.
-- `user` is optional in the schema — the app must populate it (the same
-- orphan hazard as billing's unresolved userId).
pred OrphanCheckout {
  some s: CheckoutSession | no s.user and some s.items
}
run OrphanCheckout for 4

-- Merge on login: items from the anon cart fold into the user cart. On a
-- shared priceId, which quantity wins is an application rule (newer
-- addedAt) — the relation alone keeps both Items.
pred MergeConflict {
  some u: User, a: AnonSession, uc, ac: Cart |
    uc.owner = u and ac.owner = a and
    some disj i1, i2: Item |
      i1 in uc.items.Int and i2 in ac.items.Int and i1.priceId = i2.priceId
}
run MergeConflict for 5

-- Schema permits an empty checkout (items relation may be empty) — the
-- app must refuse checkout on an empty cart.
pred EmptyCheckout {
  some s: CheckoutSession | no s.items
}
run EmptyCheckout for 4

-- Schema permits two line items on one cart with the same priceId — the
-- app keys items by priceId to keep one line per price.
pred DuplicatePriceInCart {
  some c: Cart | some disj i1, i2: Item |
    i1 in c.items.Int and i2 in c.items.Int and i1.priceId = i2.priceId
}
run DuplicatePriceInCart for 4

-- Nothing stops a payment-mode session from snapshotting a cart that
-- contains a recurring price. ec only sees priceId STRINGS — it cannot
-- know a price's kind — so the boundary is enforced by Stripe rejecting
-- session creation, never by the cart layer. (Alloy scenario: the shape
-- exists; the app's obligation is to let the Stripe error surface, and to
-- document that recurring prices belong to billing's flow, not carts.)
pred RecurringLineInPaymentSession {
  some s: CheckoutSession | s.mode = Payment and
    some i: s.items.Int | i.priceId.kind = Recurring
}
run RecurringLineInPaymentSession for 4

-- After a session snapshots a cart, the cart can keep changing (another
-- tab). Here the cart holds an Item whose priceId IS in the snapshot but
-- which is a different Item atom — the post-snapshot re-add shape. Drain
-- deletes by priceId, so this atom gets deleted despite being written
-- after the snapshot (Quint: noPostSnapWriteLoss counterexample).
pred PostSnapshotReadd {
  some s: CheckoutSession |
    some c: s.cart |
      some disj i1, i2: Item |
        i1 in s.items.Int and
        i2 in c.items.Int and
        i1.priceId = i2.priceId
}
run PostSnapshotReadd for 5

-- The cart at fulfill time can differ from the snapshotted items —
-- fulfillment must ship s.items (the charged snapshot), never a fresh
-- cart enumeration, or it can ship uncharged lines (Quint:
-- fulfilledExactlyCharged encodes this as the onDrained contract).
pred FulfillmentDrift {
  some s: CheckoutSession | some s.cart and s.items != s.cart.items and
    some f: Fulfillment | f.of = s and f.items = s.cart.items
}
run FulfillmentDrift for 5
