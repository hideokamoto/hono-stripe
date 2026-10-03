# Formal specification: billing layer

Executable design requirements for the subscription-billing layer
(`hono-stripe/billing`). These models exist to answer one question: **under
Stripe's at-least-once, out-of-order webhook delivery, which write policy
makes the local subscription mirror converge to Stripe's truth?**

The models are the specification. When the sync algorithm changes, re-run
verification — a change that doesn't re-verify is a regression in the design,
not just the code.

## Files

| File | What it models |
|---|---|
| `quint/billing_sync.qnt` | Full sync protocol: event emission, duplicate + out-of-order delivery, dedupe store, handler failures + redelivery, concurrent in-flight handlers, four write policies, atomic vs non-atomic stores. Owns the dedupe / at-least-once questions. |
| `quint/billing_sync_2ev.qnt` | Minimal scalar model: one subscription, two same-second events. All concurrency and tie mechanisms, no maps. The model Apalache can exhaust — this is the canonical correctness claim. |
| `alloy/billing_link.als` | Schema relational invariants + userId linkage rules. Counterexamples define requirements the sync code must enforce (the schema alone cannot). |

## Running

### Quick loop (local, Node only)

Typecheck and random simulation need no JVM — run them locally:

```bash
npx @informalsystems/quint typecheck spec/quint/billing_sync_2ev.qnt
npx @informalsystems/quint run spec/quint/billing_sync_2ev.qnt \
  --invariant=convFetchTieAtomic --max-samples=20000
```

### Registered test commands (chunk sidecar)

Four commands are registered in `.chunk/config.json` and run remotely via
`chunk validate <name>` (they auto-sync, pick a sidecar, and stream output):

| Command | What it does | Needs |
|---|---|---|
| `chunk validate spec-typecheck` | `quint typecheck` on both models | Node |
| `chunk validate spec-sim` | `quint run` all 8 invariants, 20k samples each | Node |
| `chunk validate spec-verify` | `quint verify` (Apalache) all 8 invariants, exhaustive | JVM |
| `chunk validate spec-alloy` | `java -jar ~/tools/alloy.jar exec spec/alloy/billing_link.als` | JVM |

`spec-verify` is the strong claim — run it after changing any state
assignment or `writeDecision`. `spec-sim` is the cheap pre-commit check.

### Running on a chunk sidecar

The sidecar image snapshot (`hono-stripe-jdk21-alloy-quint`, referenced from
`.chunk/config.json` → `validation.sidecarImage`) already contains JDK 21,
Quint 0.33, Apalache 0.62, and Alloy 6.2 (`~/tools/alloy.jar`). To run
against it from a fresh checkout:

```bash
chunk config set orgID <org-id>          # once per machine
chunk sidecar create --image d6820fcc-fac2-4027-8d9e-6892b4ac0556 \
  --name hono-stripe-spec
```

Useful primitives:

```bash
chunk sidecar list                        # sidecars + ids
chunk sidecar use                         # set the active sidecar
chunk sidecar sync                        # push local tree to the sidecar
chunk sidecar exec --command bash \
  --args=-lc --args="cd ~/hono-stripe && quint verify spec/quint/billing_sync_2ev.qnt \
    --invariant=convFetchTieAtomic --max-steps=12"
chunk sidecar logs <command-id>           # output of a previous exec (-f to follow)
```

`chunk sidecar exec` accepts `--sidecar-id <id>` — create several sidecars
from the same snapshot and run verifications in parallel (exhaustive
verifies take seconds-to-minutes each; parallelizing is how the result
matrix above was produced):

```bash
chunk sidecar create --image d6820fcc-fac2-4027-8d9e-6892b4ac0556 --name spec-v2
chunk sidecar sync --sidecar-id <id>
chunk sidecar exec --sidecar-id <id> --command bash --args=-lc --args="..."
```

Rules of thumb:

- `quint verify` = bounded-exhaustive; a `counterexample` verdict is
  deterministic proof of a bug, `No violation found` at depth ≥ ~10 covers
  the model's whole reachable space here.
- `quint run` = random sampling; "no violation" means *not found*, not
  proven — always pair with `spec-verify` before trusting a design change.
- Apalache (the verify backend) requires Java 21 — the sidecar has it;
  locally you need JDK 21+ for `quint verify` only.
- If you modify the model, re-run `spec-verify`. A change that does not
  re-verify is a design regression.

## Verified results

Exhaustive Apalache verification of `quint/billing_sync_2ev.qnt` (all 8
invariants, depth 12 — quiescence is ~6 steps):

| Write policy | Atomic store (SQL conditional upsert) | Non-atomic store (KV get-then-put) |
|---|---|---|
| `payload_guard` | counterexample | counterexample |
| `fetch_lww` | counterexample | counterexample |
| `fetch_guard` | counterexample | counterexample |
| `fetch_tie_refetch` | **holds (exhaustive)** | counterexample |

Plus: `neverAhead` holds (exhaustive); `executionsAtMostOnce` has a
counterexample (a failed-then-retried handler executes twice).

**Failure mechanisms found:**

- `payload_guard` / `fetch_guard`: `event.created` has 1-second granularity.
  When two events share a timestamp, the `>` ordering guard discards the
  newer one — mirror stays stale at quiescence.
- `fetch_lww`: concurrent handlers let an older retrieved snapshot overwrite
  a newer row.
- Every policy under a non-atomic store: the check-then-put gap means a
  commit can apply a decision computed against a row that has since changed.

## Design requirements derived

These are obligations the implementation must satisfy:

1. **Sync algorithm is fixed**: fetch-on-event, guarded write
   `lastEventCreated > stored`, and on a *tie* re-retrieve the subscription
   from the API and write unconditionally. No `payload` mode — it is
   provably non-convergent, so offering it would be shipping a footgun.
2. **`BillingStore.upsertSubscription` must distinguish** `written` /
   `stale` / `tie` so the sync engine can apply the tie-refetch rule.
3. **Store atomicity requirement**: the guard must execute atomically
   (SQL `ON CONFLICT DO UPDATE ... WHERE`). KV is provably best-effort —
   documented as such, with `syncFromStripe` as the recovery path.
4. **Handlers must be idempotent**: dedupe gives at-most-once
   acknowledgement, not exactly-once side effects.
5. **Customer re-link cascades**: when `customer.userId` changes, all
   owned subscription rows must be updated (schema cannot enforce the
   denormalized column's consistency).
6. **No orphan paid subscriptions**: a handler must not write a
   subscription whose userId cannot be resolved — warn and rely on
   `syncFromStripe` for later reconciliation.
7. **Deterministic entitlement pick**: with multiple subscriptions per
   user, `getState` must define "best" explicitly (status priority, then
   `lastEventCreated` desc, then id).
8. **userId resolution order is specified**: `client_reference_id` >
   `session.metadata` > `subscription.metadata` > `customer.metadata`.

## Limitations

- `quint/billing_sync_2ev.qnt` abstracts to a single subscription and two events.
  Every mechanism (ties, concurrency, non-atomicity) is exercised, but the
  proof is bounded, not inductive.
- Not modeled: `customer.deleted`, KV secondary-index partial writes,
  livemode/test separation, informational events (`trial_will_end` etc.),
  Stripe's own Entitlements API.

## Implementation coverage

| Design requirement | Implementation | Test |
| -- | -- | -- |
| fetch + guard + tie-refetch sync | `src/billing/sync.ts` (`syncSubscriptionFromApi`) | `test/billing_sync.test.ts` (vector replay) |
| `written`/`stale`/`tie` upsert | `src/billing/store/sql.ts`, `store/memory.ts` | `test/billing_store.test.ts` |
| Atomic DB guard | `sqlBillingStore` — `ON CONFLICT DO UPDATE ... WHERE` | `test/billing_store.test.ts` (sqlite backend) |
| Schedule coverage | — | `test/fixtures/sync/*.json` (Quint MBT traces via `spec/tools/itf2vector.mjs`) |
| Idempotent mirror / retryable handlers | event-guarded upsert | vector replay + store contract |
| Relink cascade | `relinkCustomer` in both adapters | `test/billing_store.test.ts` |
| No orphan paid subs | `resolveUserIdForSubscription` + `warn` | `test/billing_sync.test.ts` |
| Deterministic pick | `pickBestSubscription` in `src/billing/entitlement.ts` | `test/billing_entitlement.test.ts` |
| userId resolution order | `checkout.session.completed` handler | `test/billing_sync.test.ts` |

## `ec` — cart storage on a weak KVS (spec/quint/cart_ops.qnt, spec/alloy/cart_link.als)

Design: one item key per cart line (`cart:{id}:item:{priceId}`), all
mutations as pure puts/deletes (no read-modify-write), checkout =
enumerate → charge → delete only snapshotted keys. `view` lags `truth`
(pending writes) to model edge-cache staleness.

| Property | Result |
| -- | -- |
| `deletesOnlySnapshotted` | ✅ holds — post-snapshot adds always survive |
| `chargesOnlyVisible` | ✅ holds — only snap-time visible keys are charged |
| `divergenceOnlyPending` | ✅ sim 30k no violation (bounded verify timed out; holds by construction) |
| `noStaleCharge` | ⚠️ counterexample exists — **a stale snapshot can charge an item the user already removed**. Documented boundary of KVS carts; mitigate by showing server-side line items at checkout confirmation (Stripe Checkout does) and/or a pre-charge re-read. |

Alloy scenarios (all SAT — app-level rules the layout cannot enforce):

- `TwoCartsOneUser` — login must merge anon + user carts
- `OrphanCheckout` — checkout.user must be populated (billing's orphan hazard)
- `MergeConflict` — same priceId across carts needs a merge rule (newer addedAt)
- `EmptyCheckout` — refuse checkout on empty cart
- `DuplicatePriceInCart` — key line items by priceId in the app
