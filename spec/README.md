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
(pending writes) to model edge-cache staleness. TTL expiry is modeled as a
store-side delete joining `pending` — an expired key keeps diverging until
the edge propagates it.

| Property | Result |
| -- | -- |
| `deletesOnlySnapshotted` | ✅ verify — no violation through depth 8; drain can only remove keys it snapshotted |
| `chargesOnlyVisible` | ✅ verify — no violation through depth 8; only snap-time visible keys are charged |
| `divergenceOnlyPending` | ✅ sim 30k no violation (bounded verify timed out; holds by construction) — expiry joins `pending`, so divergence stays bounded to in-flight keys |
| `fulfilledExactlyCharged` | ✅ verify — no violation through depth 8; fulfillment batches are exactly the charged snapshots (the `onDrained` contract: hand the callback the session's line items, never a re-enumerated cart list) |
| `noStaleCharge` | ⚠️ counterexample (Apalache verified) — **a stale snapshot can charge an item the user already removed**. Documented boundary of KVS carts; mitigate by showing server-side line items at checkout confirmation (Stripe Checkout does) and/or a pre-charge re-read. |
| `noPostSnapWriteLoss` | ⚠️ counterexample (Apalache verified) — **re-adding a snapshotted priceId while checkout is in-flight loses that write**. Drain deletes by key and cannot distinguish the snapshotted line from a post-snapshot re-add. Post-snapshot adds on OTHER priceIds still survive. Rare (checkout window); acceptable boundary — key versioning would fix it at contract cost. |
| `noExpiryCharge` | ⚠️ counterexample (Apalache verified) — **a TTL'd line can expire between snap and commit and still be charged**. Bound cart TTL far above the checkout completion window (KV `expirationTtl` in hours/days, checkout in minutes); same mitigation class as `noStaleCharge`. |

Alloy scenarios (all SAT — app-level rules the layout cannot enforce):

- `TwoCartsOneUser` — login must merge anon + user carts
- `OrphanCheckout` — checkout.user must be populated (billing's orphan hazard)
- `MergeConflict` — same priceId across carts needs a merge rule (newer addedAt)
- `EmptyCheckout` — refuse checkout on empty cart
- `DuplicatePriceInCart` — key line items by priceId in the app
- `RecurringLineInPaymentSession` — a `mode: 'payment'` session CAN carry a recurring-priced line; ec only sees priceId strings so it cannot pre-filter — Stripe rejects at session create. Recurring prices belong to billing's flow, not carts (documented boundary)
- `PostSnapshotReadd` — the relational shape of `noPostSnapWriteLoss`: cart holds a NEW Item atom with a priceId the session already snapshotted — drain deletes it anyway
- `FulfillmentDrift` — cart contents at fulfill time can differ from the snapshot; fulfillment must ship `session.items`, never a fresh cart enumeration

## `ec` implementation coverage

| Design requirement | Implementation | Test |
| -- | -- | -- |
| Pure put/delete mutations, no read-modify-write | `CartStore` contract (`src/ec/types.ts`), `memoryCartStore`, `kvCartStore` | `test/helpers/cartStoreContract.ts` (run against every adapter) |
| Checkout = enumerate → snapshot → delete only snapshotted keys | `checkout` + `drain` (`src/ec/index.ts`) | `test/ec_cart.test.ts` |
| Webhook drain on `checkout.session.completed` (payment only) | `handlers` — `client_reference_id` carries the cart id | `test/ec_cart.test.ts` |
| `list` enumerates every line (no truncation) | `kvCartStore` paginates to `list_complete` | `test/ec_store_kv.test.ts` |
| Stale-charge hazard (documented boundary, not enforceable) | `CartStore` JSDoc; `warn` on truncated drain | — |
| Post-snapshot re-add loss (documented boundary) | `drain`/`handlers` JSDoc — `noPostSnapWriteLoss` | `test/ec_vectors.test.ts` (boundary vectors) |
| TTL expiry charge (documented boundary) | `CartStore` + `kvCartStore` JSDoc — TTL guidance (`noExpiryCharge`) | `test/ec_vectors.test.ts` |
| `onDrained` = charged snapshot, never re-enumeration (`fulfilledExactlyCharged`) | `handlers` callback passes session line items | `test/ec_ondrained.test.ts` |
| Recurring price in cart → Stripe rejects session create (documented boundary) | `CartCheckoutParams.mode` is `'payment'` | — |
| Schedule coverage (incl. boundary schedules) | — | `test/fixtures/ec/*.json` (Quint MBT traces via `spec/tools/itf2cartvector.mjs`) |
| Login merge anon + user carts (`TwoCartsOneUser`) | `merge` | `test/ec_cart.test.ts` |
| Merge conflict → newer addedAt wins (`MergeConflict`) | `merge` addedAt comparison | `test/ec_cart.test.ts` |
| Refuse empty checkout (`EmptyCheckout`) | `checkout` throws | `test/ec_cart.test.ts` |
| Populate resolvable owner (`OrphanCheckout`) | `checkout` stamps `client_reference_id: cartId` | `test/ec_cart.test.ts` |
| One line per price (`DuplicatePriceInCart`) | `CartItem` keyed by `priceId` | `test/ec_cart.test.ts` |
