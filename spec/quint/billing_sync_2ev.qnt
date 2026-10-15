module billing_sync_2ev {
  // ==================================================================
  // Minimal hand-rolled variant of billing_sync: two same-second events
  // (created = 1 for both), one subscription. Scalar state only — no
  // maps, no bounded sets — so Apalache can exhaust the state space and
  // give a definitive verdict on convergence for every policy.
  //
  // Semantics identical to billing_sync_min:
  //   emit advances truth 0 -> 1 -> 2, pushing seq into pending
  //   deliver starts a handler (snapshot: payload ver or current truth)
  //   finish writes per policy + atomicity
  //
  // quiescence = both events delivered and settled; convergence requires
  // mirrorVersion == 2 (the final truth).
  // ==================================================================

  var policy: str
  var storeAtomic: bool

  var truth: int

  /// Event ids whose single copy is undelivered.
  var pending: Set[int]
  /// Event ids whose handler finished successfully (dedupe store).
  var seen: Set[int]
  /// Event ids with an in-flight handler.
  var inflight: Set[int]

  /// Per-event handler state (-1 / false = unset).
  var snap1: int
  var snap2: int
  var chk1: bool
  var chk2: bool
  var wv1: int
  var wv2: int

  var mirrorCreated: int
  var mirrorVersion: int

  pure def createdOf(seq: int): int = 1 // both events share the same second

  pure def writeDecision(
    pol: str, evCreated: int, snap: int, mCreated: int, truthNow: int
  ): int =
    if (pol == "fetch_lww") snap
    else if (evCreated > mCreated) snap
    else if (pol == "fetch_tie_refetch" and evCreated == mCreated) truthNow
    else -1

  action noop = all {
    policy' = policy, storeAtomic' = storeAtomic,
    truth' = truth, pending' = pending, seen' = seen, inflight' = inflight,
    snap1' = snap1, snap2' = snap2, chk1' = chk1, chk2' = chk2,
    wv1' = wv1, wv2' = wv2,
    mirrorCreated' = mirrorCreated, mirrorVersion' = mirrorVersion,
  }

  action init =
    nondet p = Set(
      "payload_guard", "fetch_lww", "fetch_guard", "fetch_tie_refetch"
    ).oneOf()
    nondet a = Set(true, false).oneOf()
    all {
      policy' = p,
      storeAtomic' = a,
      truth' = 0,
      pending' = Set(),
      seen' = Set(),
      inflight' = Set(),
      snap1' = -1, snap2' = -1,
      chk1' = false, chk2' = false,
      wv1' = -1, wv2' = -1,
      mirrorCreated' = -1,
      mirrorVersion' = -1,
    }

  action emit =
    if (truth < 2)
      all {
        truth' = truth + 1,
        pending' = pending.union(Set(truth + 1)),
        seen' = seen, inflight' = inflight,
        snap1' = snap1, snap2' = snap2, chk1' = chk1, chk2' = chk2,
        wv1' = wv1, wv2' = wv2,
        mirrorCreated' = mirrorCreated, mirrorVersion' = mirrorVersion,
        policy' = policy, storeAtomic' = storeAtomic,
      }
    else noop

  /// Snapshot a handler takes when it starts: the event's own version for
  /// payload_guard, the current truth for fetch policies.
  def snapFor(seq: int): int =
    if (policy == "payload_guard") seq else truth

  action deliver1 =
    if (pending.contains(1) and not(seen.contains(1)))
      all {
        inflight' = inflight.union(Set(1)),
        pending' = pending.exclude(Set(1)),
        snap1' = snapFor(1),
        truth' = truth, seen' = seen,
        snap2' = snap2, chk1' = chk1, chk2' = chk2, wv1' = wv1, wv2' = wv2,
        mirrorCreated' = mirrorCreated, mirrorVersion' = mirrorVersion,
        policy' = policy, storeAtomic' = storeAtomic,
      }
    else noop

  action deliver2 =
    if (pending.contains(2) and not(seen.contains(2)))
      all {
        inflight' = inflight.union(Set(2)),
        pending' = pending.exclude(Set(2)),
        snap2' = snapFor(2),
        truth' = truth, seen' = seen,
        snap1' = snap1, chk1' = chk1, chk2' = chk2, wv1' = wv1, wv2' = wv2,
        mirrorCreated' = mirrorCreated, mirrorVersion' = mirrorVersion,
        policy' = policy, storeAtomic' = storeAtomic,
      }
    else noop

  /// Atomic finish: guard-check + write in one step (SQL conditional upsert).
  action finishAtomic1 =
    if (storeAtomic and inflight.contains(1))
      val wv = writeDecision(policy, createdOf(1), snap1, mirrorCreated, truth)
      all {
        mirrorCreated' = if (wv >= 0) createdOf(1) else mirrorCreated,
        mirrorVersion' = if (wv >= 0) wv else mirrorVersion,
        seen' = seen.union(Set(1)),
        inflight' = inflight.exclude(Set(1)),
        truth' = truth, pending' = pending,
        snap1' = snap1, snap2' = snap2, chk1' = chk1, chk2' = chk2,
        wv1' = wv1, wv2' = wv2,
        policy' = policy, storeAtomic' = storeAtomic,
      }
    else noop

  action finishAtomic2 =
    if (storeAtomic and inflight.contains(2))
      val wv = writeDecision(policy, createdOf(2), snap2, mirrorCreated, truth)
      all {
        mirrorCreated' = if (wv >= 0) createdOf(2) else mirrorCreated,
        mirrorVersion' = if (wv >= 0) wv else mirrorVersion,
        seen' = seen.union(Set(2)),
        inflight' = inflight.exclude(Set(2)),
        truth' = truth, pending' = pending,
        snap1' = snap1, snap2' = snap2, chk1' = chk1, chk2' = chk2,
        wv1' = wv1, wv2' = wv2,
        policy' = policy, storeAtomic' = storeAtomic,
      }
    else noop

  /// Non-atomic (KV): phase 1 decides with the row value read now.
  action beginFinish1 =
    if (not(storeAtomic) and inflight.contains(1) and not(chk1))
      all {
        chk1' = true,
        wv1' = writeDecision(policy, createdOf(1), snap1, mirrorCreated, truth),
        truth' = truth, pending' = pending, seen' = seen, inflight' = inflight,
        snap1' = snap1, snap2' = snap2, chk2' = chk2, wv2' = wv2,
        mirrorCreated' = mirrorCreated, mirrorVersion' = mirrorVersion,
        policy' = policy, storeAtomic' = storeAtomic,
      }
    else noop

  action beginFinish2 =
    if (not(storeAtomic) and inflight.contains(2) and not(chk2))
      all {
        chk2' = true,
        wv2' = writeDecision(policy, createdOf(2), snap2, mirrorCreated, truth),
        truth' = truth, pending' = pending, seen' = seen, inflight' = inflight,
        snap1' = snap1, snap2' = snap2, chk1' = chk1, wv1' = wv1,
        mirrorCreated' = mirrorCreated, mirrorVersion' = mirrorVersion,
        policy' = policy, storeAtomic' = storeAtomic,
      }
    else noop

  /// Non-atomic: phase 2 commits the possibly-stale decision.
  action commitFinish1 =
    if (not(storeAtomic) and inflight.contains(1) and chk1)
      all {
        mirrorCreated' = if (wv1 >= 0) createdOf(1) else mirrorCreated,
        mirrorVersion' = if (wv1 >= 0) wv1 else mirrorVersion,
        seen' = seen.union(Set(1)),
        inflight' = inflight.exclude(Set(1)),
        truth' = truth, pending' = pending,
        snap1' = snap1, snap2' = snap2, chk1' = chk1, chk2' = chk2,
        wv1' = wv1, wv2' = wv2,
        policy' = policy, storeAtomic' = storeAtomic,
      }
    else noop

  action commitFinish2 =
    if (not(storeAtomic) and inflight.contains(2) and chk2)
      all {
        mirrorCreated' = if (wv2 >= 0) createdOf(2) else mirrorCreated,
        mirrorVersion' = if (wv2 >= 0) wv2 else mirrorVersion,
        seen' = seen.union(Set(2)),
        inflight' = inflight.exclude(Set(2)),
        truth' = truth, pending' = pending,
        snap1' = snap1, snap2' = snap2, chk1' = chk1, chk2' = chk2,
        wv1' = wv1, wv2' = wv2,
        policy' = policy, storeAtomic' = storeAtomic,
      }
    else noop

  action step =
    nondet which = Set(0, 1, 2, 3, 4, 5, 6, 7, 8).oneOf()
    if (which == 0) emit
    else if (which == 1) deliver1
    else if (which == 2) deliver2
    else if (which == 3) finishAtomic1
    else if (which == 4) finishAtomic2
    else if (which == 5) beginFinish1
    else if (which == 6) beginFinish2
    else if (which == 7) commitFinish1
    else commitFinish2

  val quiescent =
    truth == 2 and pending.size() == 0 and inflight.size() == 0

  val convergence = quiescent implies mirrorVersion == 2
  val neverAhead = mirrorVersion <= truth

  val convPayloadAtomic =
    (policy == "payload_guard" and storeAtomic) implies convergence
  val convFetchLwwAtomic =
    (policy == "fetch_lww" and storeAtomic) implies convergence
  val convFetchGuardAtomic =
    (policy == "fetch_guard" and storeAtomic) implies convergence
  val convFetchTieAtomic =
    (policy == "fetch_tie_refetch" and storeAtomic) implies convergence
  val convPayloadKv =
    (policy == "payload_guard" and not(storeAtomic)) implies convergence
  val convFetchGuardKv =
    (policy == "fetch_guard" and not(storeAtomic)) implies convergence
  val convFetchTieKv =
    (policy == "fetch_tie_refetch" and not(storeAtomic)) implies convergence
}
