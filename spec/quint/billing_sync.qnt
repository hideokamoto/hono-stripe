module billing_sync {
  // ==================================================================
  // Subscription-state mirror under Stripe's at-least-once, out-of-order
  // webhook delivery. One subscription; MAX_SEQ state changes total.
  //
  // Each state change emits one event. seq is both the event id and the
  // generation order. event.created has 1-second granularity, so pairs of
  // consecutive events share a timestamp (createdOf).
  //
  // policy — write decision when a handler finishes successfully:
  //   "payload_guard"      write event payload iff ev.created > mirror.created
  //   "fetch_lww"          write API-retrieved snapshot unconditionally
  //   "fetch_guard"        write snapshot iff ev.created > mirror.created
  //   "fetch_tie_refetch"  fetch_guard, plus on ev.created == mirror.created
  //                        re-read the current truth and write that
  //
  // storeAtomic = true   guard-check + write in one step (SQL conditional
  //                      upsert: ON CONFLICT DO UPDATE WHERE excluded.c > t.c)
  // storeAtomic = false  check and commit in two steps (KV get-then-put:
  //                      the decision may be stale by the time we write)
  //
  // policy / storeAtomic are chosen nondeterministically at init, so
  // verification quantifies over every configuration. Per-config claims
  // are written as `policy == "..." and storeAtomic implies inv`.
  // ==================================================================

  /// Bound on state changes for tractable checking.
  pure def MAX_SEQ: int = 4

  var policy: str
  var storeAtomic: bool

  /// Stripe-side truth: current subscription version.
  var truth: int

  /// Generated events: seq -> { created, version }.
  var events: int -> { created: int, version: int }

  /// Undelivered copies: seq -> count. Duplicates live here.
  var pending: int -> int

  /// Dedupe store: event ids whose handler completed successfully.
  var seen: Set[int]

  /// In-flight handlers: seq -> { snapshot taken at start, check phase done,
  /// writeVer decided at check time (non-atomic mode) }.
  var processing: int -> { snapshot: int, checked: bool, writeVer: int }

  /// The mirror row.
  var mirrorCreated: int
  var mirrorVersion: int

  /// seq -> number of handler executions (side-effect runs).
  var executions: int -> int

  /// 1-second event.created granularity: seq pairs {1,2},{3,4} share a second.
  pure def createdOf(seq: int): int = (seq + 1) / 2

  pure def getOr(m: int -> int, k: int, d: int): int =
    if (m.keys().contains(k)) m.get(k) else d

  def pendingCount(seq: int): int = getOr(pending, seq, 0)
  def executionCount(seq: int): int = getOr(executions, seq, 0)

  /// Write decision made with mirror created `mCreated` and truth `truthNow`.
  /// Returns the version to write, or -1 for "no write".
  pure def writeDecision(
    pol: str, evCreated: int, snap: int, mCreated: int, truthNow: int
  ): int =
    if (pol == "fetch_lww") snap
    else if (evCreated > mCreated) snap
    else if (pol == "fetch_tie_refetch" and evCreated == mCreated) truthNow
    else -1

  action noop = all {
    policy' = policy, storeAtomic' = storeAtomic,
    truth' = truth, events' = events, pending' = pending,
    seen' = seen, processing' = processing,
    mirrorCreated' = mirrorCreated, mirrorVersion' = mirrorVersion,
    executions' = executions,
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
      events' = Map(),
      pending' = Map(),
      seen' = Set(),
      processing' = Map(),
      mirrorCreated' = -1,
      mirrorVersion' = -1,
      executions' = Map(),
    }

  /// Stripe state advances: emits an event, possibly double-delivered.
  action emit =
    nondet copies = Set(1, 2).oneOf()
    val seq = truth + 1
    if (truth < MAX_SEQ)
      all {
        events' = events.put(seq, { created: createdOf(seq), version: seq }),
        pending' = pending.put(seq, pendingCount(seq) + copies),
        truth' = seq,
        processing' = processing,
        seen' = seen,
        mirrorCreated' = mirrorCreated,
        mirrorVersion' = mirrorVersion,
        executions' = executions,
        policy' = policy, storeAtomic' = storeAtomic,
      }
    else noop

  /// One pending copy is delivered. Already-processed ids are acknowledged
  /// without running the handler (dedupe); fresh ids start a handler.
  action deliver =
    val deliverable = pending.keys().filter(s => pending.get(s) > 0)
    if (deliverable.size() == 0) noop
    else
      nondet seq = deliverable.oneOf()
      if (seen.contains(seq))
        all {
          pending' = pending.put(seq, pending.get(seq) - 1),
          truth' = truth, events' = events, processing' = processing,
          seen' = seen, mirrorCreated' = mirrorCreated,
          mirrorVersion' = mirrorVersion, executions' = executions,
          policy' = policy, storeAtomic' = storeAtomic,
        }
      else
        all {
          // fetch policies retrieve truth at handler start; payload uses the
          // event body itself
          processing' = processing.put(seq, {
            snapshot:
              if (policy == "payload_guard") events.get(seq).version
              else truth,
            checked: false,
            writeVer: -1,
          }),
          pending' = pending.put(seq, pending.get(seq) - 1),
          executions' = executions.put(seq, executionCount(seq) + 1),
          truth' = truth, events' = events, seen' = seen,
          mirrorCreated' = mirrorCreated, mirrorVersion' = mirrorVersion,
          policy' = policy, storeAtomic' = storeAtomic,
        }

  /// Atomic finish (storeAtomic): guard-check and write in one step.
  /// On failure the delivery is re-queued — Stripe retries it.
  action finishAtomic =
    if (not(storeAtomic) or processing.keys().size() == 0) noop
    else
      nondet seq = processing.keys().oneOf()
      nondet ok = Set(true, false).oneOf()
      nondet redeliver = Set(0, 1).oneOf()
      val p = processing.get(seq)
      val ev = events.get(seq)
      val rest =
        processing.keys().exclude(Set(seq)).mapBy(k => processing.get(k))
      if (not(ok))
        all {
          processing' = rest,
          pending' = pending.put(seq, pendingCount(seq) + 1),
          truth' = truth, events' = events, seen' = seen,
          mirrorCreated' = mirrorCreated, mirrorVersion' = mirrorVersion,
          executions' = executions,
          policy' = policy, storeAtomic' = storeAtomic,
        }
      else
        val wv =
          writeDecision(policy, ev.created, p.snapshot, mirrorCreated, truth)
        all {
          seen' = seen.union(Set(seq)),
          processing' = rest,
          pending' = pending.put(seq, pendingCount(seq) + redeliver),
          mirrorCreated' = if (wv >= 0) ev.created else mirrorCreated,
          mirrorVersion' = if (wv >= 0) wv else mirrorVersion,
          truth' = truth, events' = events, executions' = executions,
          policy' = policy, storeAtomic' = storeAtomic,
        }

  /// Non-atomic finish, phase 1 (KV get): decide using the row value read
  /// NOW — which may go stale before commitFinish writes.
  action beginFinish =
    val candidates =
      processing.keys().filter(s => not(processing.get(s).checked))
    if (storeAtomic or candidates.size() == 0) noop
    else
      nondet seq = candidates.oneOf()
      nondet ok = Set(true, false).oneOf()
      val p = processing.get(seq)
      val ev = events.get(seq)
      if (not(ok))
        all {
          processing' =
            processing.keys().exclude(Set(seq)).mapBy(k => processing.get(k)),
          pending' = pending.put(seq, pendingCount(seq) + 1),
          truth' = truth, events' = events, seen' = seen,
          mirrorCreated' = mirrorCreated, mirrorVersion' = mirrorVersion,
          executions' = executions,
          policy' = policy, storeAtomic' = storeAtomic,
        }
      else
        all {
          processing' = processing.put(seq, {
            snapshot: p.snapshot,
            checked: true,
            writeVer: writeDecision(
              policy, ev.created, p.snapshot, mirrorCreated, truth),
          }),
          truth' = truth, events' = events, pending' = pending,
          seen' = seen, mirrorCreated' = mirrorCreated,
          mirrorVersion' = mirrorVersion, executions' = executions,
          policy' = policy, storeAtomic' = storeAtomic,
        }

  /// Non-atomic finish, phase 2 (KV put): commit the possibly-stale decision.
  action commitFinish =
    val candidates = processing.keys().filter(s => processing.get(s).checked)
    if (storeAtomic or candidates.size() == 0) noop
    else
      nondet seq = candidates.oneOf()
      nondet redeliver = Set(0, 1).oneOf()
      val p = processing.get(seq)
      val ev = events.get(seq)
      all {
        seen' = seen.union(Set(seq)),
        processing' =
          processing.keys().exclude(Set(seq)).mapBy(k => processing.get(k)),
        pending' = pending.put(seq, pendingCount(seq) + redeliver),
        mirrorCreated' = if (p.writeVer >= 0) ev.created else mirrorCreated,
        mirrorVersion' = if (p.writeVer >= 0) p.writeVer else mirrorVersion,
        truth' = truth, events' = events, executions' = executions,
        policy' = policy, storeAtomic' = storeAtomic,
      }

  action step =
    nondet which = Set(0, 1, 2, 3, 4).oneOf()
    if (which == 0) emit
    else if (which == 1) deliver
    else if (which == 2) finishAtomic
    else if (which == 3) beginFinish
    else commitFinish

  /// Everything emitted has been delivered and every handler settled.
  val quiescent =
    truth == MAX_SEQ and
    pending.keys().forall(s => pending.get(s) == 0) and
    processing.keys().size() == 0

  /// Convergence: at quiescence the mirror must equal Stripe's truth —
  /// THE key property of the sync engine.
  val convergence = quiescent implies mirrorVersion == truth

  /// The mirror never claims a version Stripe has not reached. Sanity.
  val neverAhead = mirrorVersion <= truth

  /// Idealized exactly-once handler execution.
  /// EXPECTED TO FAIL — a failed+retried handler executes twice; dedupe
  /// gives at-most-once acknowledgment, not exactly-once side effects.
  val executionsAtMostOnce =
    executions.keys().forall(s => executions.get(s) <= 1)

  // ---- per-configuration convergence claims -----------------------------

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
