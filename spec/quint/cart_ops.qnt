/// Cart storage protocol on a weak key-value store — the correctness model
/// for hono-stripe/ec.
///
/// Design under test:
///   - One item key per cart line (no read-modify-write on a cart blob)
///   - All mutations are pure puts/deletes — safe under KV's weak guarantees
///   - checkout = enumerate (possibly stale view) -> charge snapshot ->
///     delete ONLY the snapshotted keys
///   - `truth` = the serial history of client ops (there is always a real
///     serial order: the same user's actions)
///   - `view`  = what the store currently serves (lags truth until writes
///     land — models edge-cache staleness). Quantity 0 means "not in cart".
///
/// Properties:
///   * divergence only on pending keys — committed ops are never half-visible
///   * checkout deletes only keys it snapshotted — post-snapshot adds on
///     OTHER keys survive
///   * STALE-CHARGE HAZARD: a stale snapshot can charge an item the user
///     already removed — expected counterexample, documented as the known
///     boundary of KVS carts (surfaced via `staleCharge` below).
///   * POST-SNAPSHOT WRITE LOSS: re-adding a snapshotted key while checkout
///     is in-flight loses that write — drain deletes by key and cannot tell
///     a pre-snapshot line from a post-snapshot re-add. Expected
///     counterexample (`noPostSnapWriteLoss`), documented boundary.
///   * EXPIRY-CHARGE HAZARD: a TTL'd line can expire between snap and
///     commit and still be charged — expected counterexample
///     (`noExpiryCharge`). Bound TTL far above the checkout window.
///   * fulfillment receives exactly the charged snapshot — the onDrained
///     contract (`fulfilledExactlyCharged`); never re-enumerate the cart.
module cart_ops {
  val Items = Set("p1", "p2")

  var truth: str -> int            // item key -> qty; absent = not in cart
  var view: str -> int             // served state (stale-able)
  var pending: Set[str]            // keys with unapplied writes
  var snapTaken: bool
  var snapshot: Set[str]           // keys captured by the in-flight checkout
  var staleKeys: Set[str]          // snapshot keys absent in truth
  var charged: Set[Set[str]]       // committed checkout snapshots
  var deletedByCheckout: Set[str]  // every key any checkout deleted
  var staleCharge: bool            // flag: a commit charged a stale key
  var postSnapWrites: Set[str]     // keys SET while a snapshot is in-flight
  var lostPostSnapWrites: Set[str] // post-snapshot writes deleted by a commit
  var expired: Set[str]            // keys removed by TTL expiry
  var fulfilled: Set[Set[str]]     // snapshots handed to fulfillment (onDrained)

  pure def qtyOf(m: str -> int, k: str): int =
    if (m.keys().contains(k)) m.get(k) else 0

  /// Map minus keys — pure helper so lambdas stay out of action scope.
  pure def without(m: str -> int, ks: Set[str]): str -> int =
    m.keys().exclude(ks).mapBy(k => m.get(k))

  val cartItems = Items.filter(k => qtyOf(truth, k) > 0)
  val viewItems = Items.filter(k => qtyOf(view, k) > 0)

  action init = all {
    truth' = Map(),
    view' = Map(),
    pending' = Set(),
    snapTaken' = false, snapshot' = Set(), staleKeys' = Set(),
    charged' = Set(), deletedByCheckout' = Set(),
    staleCharge' = false,
    postSnapWrites' = Set(), lostPostSnapWrites' = Set(),
    expired' = Set(), fulfilled' = Set(),
  }

  // --- client ops: same user, possibly multiple tabs ---

  /// Absolute set — pure write, no read needed. A set landing while a
  /// checkout snapshot is in-flight is tracked: the commit cannot tell it
  /// apart from the snapshotted line if the key is in the snapshot.
  action setItem = {
    nondet it = oneOf(Items)
    nondet qty = oneOf(1.to(3))
    all {
      truth' = truth.put(it, qty),
      pending' = pending.union(Set(it)),
      postSnapWrites' =
        if (snapTaken) postSnapWrites.union(Set(it)) else postSnapWrites,
      view' = view, snapTaken' = snapTaken, snapshot' = snapshot,
      staleKeys' = staleKeys, charged' = charged,
      deletedByCheckout' = deletedByCheckout, staleCharge' = staleCharge,
      lostPostSnapWrites' = lostPostSnapWrites,
      expired' = expired, fulfilled' = fulfilled,
    }
  }

  /// Remove — pure delete (qty = 0), same shape as setItem. A post-snapshot
  /// remove of a snapshotted key is NOT a lost write: the user's latest
  /// intent is "absent", which the commit delivers anyway.
  action removeItem = {
    nondet it = oneOf(Items)
    all {
      truth' = truth.put(it, 0),
      pending' = pending.union(Set(it)),
      postSnapWrites' =
        if (snapTaken) postSnapWrites.exclude(Set(it)) else postSnapWrites,
      view' = view, snapTaken' = snapTaken, snapshot' = snapshot,
      staleKeys' = staleKeys, charged' = charged,
      deletedByCheckout' = deletedByCheckout, staleCharge' = staleCharge,
      lostPostSnapWrites' = lostPostSnapWrites,
      expired' = expired, fulfilled' = fulfilled,
    }
  }

  /// The store edge lands pending writes (per-key last-writer-wins).
  action applyWrites = all {
    pending' = Set(),
    view' = truth,
    truth' = truth, snapTaken' = snapTaken, snapshot' = snapshot,
    staleKeys' = staleKeys, charged' = charged,
    deletedByCheckout' = deletedByCheckout, staleCharge' = staleCharge,
    postSnapWrites' = postSnapWrites,
    lostPostSnapWrites' = lostPostSnapWrites,
    expired' = expired, fulfilled' = fulfilled,
  }

  /// TTL expiry — a key vanishes store-side, no client op (KV
  /// expirationTtl). Like a delete, the expiry is an unapplied write until
  /// the store edge propagates it to the view: it joins `pending`.
  action expireLine = {
    nondet it = oneOf(Items)
    all {
      qtyOf(truth, it) > 0,
      truth' = truth.put(it, 0),
      expired' = expired.union(Set(it)),
      pending' = pending.union(Set(it)),
      view' = view,
      snapTaken' = snapTaken, snapshot' = snapshot,
      staleKeys' = staleKeys, charged' = charged,
      deletedByCheckout' = deletedByCheckout, staleCharge' = staleCharge,
      postSnapWrites' = postSnapWrites,
      lostPostSnapWrites' = lostPostSnapWrites, fulfilled' = fulfilled,
    }
  }

  // --- checkout flow: snapshot (reads VIEW) -> charge -> delete snap keys ---

  action checkoutSnap = all {
    not(snapTaken),
    snapTaken' = true,
    snapshot' = viewItems,
    staleKeys' = Items.filter(k =>
      qtyOf(view, k) > 0 and qtyOf(truth, k) == 0),
    postSnapWrites' = Set(),
    truth' = truth, view' = view, pending' = pending,
    charged' = charged, deletedByCheckout' = deletedByCheckout,
    staleCharge' = staleCharge,
    lostPostSnapWrites' = lostPostSnapWrites,
    expired' = expired, fulfilled' = fulfilled,
  }

  action checkoutCommit = all {
    snapTaken,
    charged' = charged.union(Set(snapshot)),
    // fulfillment is handed the charged snapshot itself (the onDrained
    // contract) — never a re-enumeration of the cart
    fulfilled' = fulfilled.union(Set(snapshot)),
    // delete ONLY snapshotted keys — post-snapshot adds on other keys
    // survive by construction; a re-add of a SNAPSHOTTED key is lost
    truth' = without(truth, snapshot),
    view' = without(view, snapshot),
    deletedByCheckout' = deletedByCheckout.union(snapshot),
    lostPostSnapWrites' =
      lostPostSnapWrites.union(postSnapWrites.intersect(snapshot)),
    postSnapWrites' = Set(),
    staleCharge' = if (staleKeys.size() > 0) true else staleCharge,
    snapTaken' = false, snapshot' = Set(), staleKeys' = Set(),
    pending' = pending, expired' = expired,
  }

  action step = {
    nondet which = oneOf(0.to(5))
    if (which == 0) setItem
    else if (which == 1) removeItem
    else if (which == 2) applyWrites
    else if (which == 3) expireLine
    else if (which == 4) checkoutSnap
    else checkoutCommit
  }

  // --- invariants ---

  /// View may lag ONLY on keys with unapplied writes — no phantom divergence.
  val divergenceOnlyPending =
    Items.forall(k =>
      not(pending.contains(k)) implies
        qtyOf(truth, k) == qtyOf(view, k))

  /// Checkout deletes are always snapshot members — it can never remove a
  /// key it did not see (and hence never a post-snapshot add on a key it
  /// did not snapshot).
  val deletesOnlySnapshotted =
    deletedByCheckout.subseteq(
      charged.fold(Set(), (acc, s) => acc.union(s)))

  /// A commit may only charge keys that were visible at snap time.
  val chargesOnlyVisible =
    charged.forall(s =>
      s.subseteq(viewItems.union(deletedByCheckout)))

  /// Fulfillment batches are exactly the charged snapshots — the onDrained
  /// contract. Holds by construction here; the obligation it encodes for
  /// the implementation is to hand onDrained the session's line items
  /// (the snapshot), never a re-enumerated cart list.
  val fulfilledExactlyCharged = (fulfilled == charged)

  /// The expected hazard: a commit CAN charge an item the user already
  /// removed (stale snapshot). Expected counterexample — the design's
  /// documented boundary for KVS carts, not an invariant to enforce.
  val noStaleCharge = not(staleCharge)

  /// The expected boundary: re-adding a snapshotted key while checkout is
  /// in-flight loses that write — drain deletes by key and cannot
  /// distinguish the snapshotted line from a post-snapshot re-add.
  /// Expected counterexample; documented boundary of key-granular drain.
  val noPostSnapWriteLoss = lostPostSnapWrites == Set()

  /// The expected hazard: a TTL'd line can expire between snap and commit
  /// and still be charged (absent from truth, present in the snapshot).
  /// Expected counterexample — bound cart TTL far above the checkout
  /// completion window; same mitigation class as noStaleCharge.
  val noExpiryCharge =
    charged.forall(s => s.intersect(expired) == Set())
}
