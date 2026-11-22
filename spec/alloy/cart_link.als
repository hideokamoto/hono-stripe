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
sig Price {}

sig Cart {
  owner: one (User + AnonSession),
  items: Item -> one Int
}

sig Item {
  priceId: one Price
}

sig CheckoutSession {
  items: Item -> one Int,   -- snapshot taken at checkout time
  user: lone User,          -- resolvable owner at charge time
  cart: lone Cart           -- cart this session drained
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
