// ======================================================================
// Relational invariants of the billing schema + userId linkage rules.
// Static analysis: does the schema itself prevent bad states, or must the
// sync engine enforce them? Counterexamples below define code requirements.
// ======================================================================
module billing_link

sig UserId {}
sig StripeCustomerId {}
sig StripeSubscriptionId {}

abstract sig Status {}
one sig Active, Trialing, PastDue, Canceled, Unpaid, Incomplete,
        IncompleteExpired, Paused extends Status {}

fun entitledStatus: set Status { Active + Trialing }

// ---- stored rows --------------------------------------------------------

sig CustomerRow {
  userId: one UserId,          // app-side owner (1:1 assumption)
  stripeId: one StripeCustomerId
}

sig SubRow {
  stripeId: one StripeSubscriptionId,
  customerId: one StripeCustomerId, // Stripe's own owner reference
  userId: lone UserId,              // denormalized; none = unresolvable link
  status: one Status,
  prices: set PriceId,              // items[].price.id on the subscription
  lastEventCreated: one Int
}

// What the schema enforces on its own (unique constraints only).
fact WellFormed {
  all disj a, b: CustomerRow | a.stripeId != b.stripeId and a.userId != b.userId
  all disj a, b: SubRow | a.stripeId != b.stripeId
}

// customer row owning a sub, if synced yet
fun owner[s: SubRow]: lone CustomerRow {
  { c: CustomerRow | c.stripeId = s.customerId }
}

// ---- check 1: denormalization consistency -------------------------------
// s.userId must equal owner.userId. The schema does NOT enforce this —
// a counterexample shows the state is representable, so the sync engine
// MUST enforce it in code: on customer.userId change (re-link), cascade
// the update to all subs with the same customerId.
assert DenormConsistent {
  all s: SubRow | some owner[s] implies s.userId = owner[s].userId
}
check DenormConsistent for 6

// ---- check 2: discoverability / orphan subs ------------------------------
// A sub with no userId is invisible to entitlement while its owner may be
// paying. This state must not be silently produced by sync handlers.
run OrphanPaidSub {
  some s: SubRow | no s.userId and s.status in entitledStatus
} for 6

// ---- check 3: entitlement determinism ------------------------------------
// Nothing prevents a user holding two entitled subs. getState needs a
// deterministic "best" rule (e.g. highest lastEventCreated, then stripeId).
run TwoEntitledSubs {
  some u: UserId |
    #{ s: SubRow | s.userId = u and s.status in entitledStatus } > 1
} for 6

// ---- check 3b: gate fairness ----------------------------------------------
// TwoEntitledSubs is a SCENARIO; this is the PROPERTY it breaks. A plan gate
// that consults only the deterministic "best" pick can deny a user who holds
// another entitled sub matching the required plan — the pick is for display,
// not for gating.
//
// Model: `best` picks the entitled sub with the highest lastEventCreated
// (id tie-break omitted — the counterexample does not need it). A gate over
// price ids is represented by requiredPlan: the required PriceId set.
sig PriceId {}

fun entitled[u: UserId]: set SubRow {
  { s: SubRow | s.userId = u and s.status in entitledStatus }
}

fun bestOf[subs: set SubRow]: set SubRow {
  { s: subs | no s2: subs - s | s2.lastEventCreated > s.lastEventCreated }
}

// The buggy semantics, asserted so Alloy produces the counterexample:
// "if ANY entitled sub carries a required price, the BEST pick carries one."
assert GateFairness {
  all u: UserId, req: set PriceId |
    (some s: entitled[u] | some (s.prices & req)) implies
      some (bestOf[entitled[u]].prices & req)
}
check GateFairness for 6
// EXPECTED: counterexample (older sub_pro + newer sub_basic, gate 'pro').
// Derived requirement: requirePlan must evaluate every entitled sub's
// prices — getState surfaces them as `entitledPlans`, and the middleware
// intersects that set with the required plans.

// ---- check 4: linkage source conflicts -----------------------------------
// userId resolution order:
//   session.client_reference_id > session.metadata >
//   subscription.metadata > customer.metadata
sig CheckoutSession {
  refUser: lone UserId,      // client_reference_id
  metaUser: lone UserId,     // session.metadata
  subMetaUser: lone UserId,  // subscription.metadata
  cusMetaUser: lone UserId   // customer.metadata
}

fun resolve[s: CheckoutSession]: lone UserId {
  some s.refUser => s.refUser
  else some s.metaUser => s.metaUser
  else some s.subMetaUser => s.subMetaUser
  else s.cusMetaUser
}

// Resolution is deterministic by construction — but when sources disagree,
// lower-priority sources are silently ignored. Counterexample shows a
// mis-link hazard: apps must set ONE canonical source (checkoutParams).
run ResolveConflict {
  some s: CheckoutSession |
    some s.refUser and some s.cusMetaUser and s.refUser != s.cusMetaUser
} for 5

run ResolveAbsent {
  some s: CheckoutSession | no resolve[s]
} for 5
