#!/usr/bin/env node
// Convert Quint ITF/MBT traces of spec/quint/cart_ops.qnt into test vectors
// replayed by test/ec_vectors.test.ts.
//
// Usage:
//   quint run spec/quint/cart_ops.qnt --mbt \
//     --out-itf=/tmp/carttraces/t_{#}.itf.json --n-traces=3000 --max-steps=15
//   node spec/tools/itf2cartvector.mjs /tmp/carttraces test/fixtures/ec
//
// Each vector is an action schedule plus the model's end state:
//   { name, events, final }
//   events: { op: 'setItem'|'removeItem'|'applyWrites'|'expireLine'|
//                 'checkoutSnap'|'checkoutCommit', it?, qty? }
//   final:  { truth, view, charged, expired, lostPostSnapWrites, staleCharge }
//
// The harness replays `events` through the real stripeCart on a staged
// (weak-store simulation) adapter and asserts the end state — including the
// documented-boundary flags (a schedule that produced staleCharge or a
// lost post-snapshot write must produce it in the implementation too).

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'path'

const dec = (v) => {
  if (v && typeof v === 'object') {
    if ('#bigint' in v) return Number(v['#bigint'])
    if ('#map' in v) return Object.fromEntries(v['#map'].map(([k, x]) => [dec(k), dec(x)]))
    if ('#set' in v) return v['#set'].map(dec)
    if ('#tup' in v) return v['#tup'].map(dec)
    if ('tag' in v && 'value' in v) return v.tag === 'Some' ? dec(v.value) : null
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]))
  }
  return v
}

const WHICH = [
  'setItem',
  'removeItem',
  'applyWrites',
  'expireLine',
  'checkoutSnap',
  'checkoutCommit',
]

const srcDir = process.argv[2]
const outDir = process.argv[3]
if (!srcDir || !outDir) {
  console.error('usage: itf2cartvector.mjs <traces-dir> <out-dir>')
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const RELEVANT = [
  'truth',
  'view',
  'pending',
  'snapTaken',
  'snapshot',
  'charged',
  'deletedByCheckout',
  'postSnapWrites',
  'expired',
  'fulfilled',
]

const vectors = []
for (const f of readdirSync(srcDir).filter((f) => f.endsWith('.itf.json'))) {
  let states
  try {
    states = JSON.parse(readFileSync(join(srcDir, f), 'utf8')).states
  } catch {
    continue
  }
  if (!states?.length) continue

  const events = []
  for (let i = 1; i < states.length; i++) {
    const picks = states[i]['mbt::nondetPicks']
    const which = dec(picks?.which)
    if (which === null || which === undefined) continue
    const op = WHICH[which]
    if (!op) continue
    // Skip dead transitions — a pick whose action guard failed (noop).
    const prev = states[i - 1]
    const cur = states[i]
    if (
      RELEVANT.every((k) => same(dec(cur[k]), dec(prev[k]))) &&
      cur.staleCharge === prev.staleCharge
    ) {
      continue
    }
    const ev = { op }
    const it = dec(picks.it)
    const qty = dec(picks.qty)
    if (it !== null && it !== undefined) ev.it = it
    if (qty !== null && qty !== undefined) ev.qty = qty
    events.push(ev)
  }

  const last = states[states.length - 1]
  vectors.push({
    events,
    final: {
      truth: dec(last.truth),
      view: dec(last.view),
      charged: dec(last.charged),
      expired: dec(last.expired),
      lostPostSnapWrites: dec(last.lostPostSnapWrites),
      staleCharge: dec(last.staleCharge),
    },
    signature: JSON.stringify(events.map((e) => [e.op, e.it, e.qty])),
  })
}

// Dedupe by schedule; prefer schedules that exercise boundaries — a vector
// that produced a lost write or a stale charge is worth more than a happy
// path. Keep the shortest few schedules per boundary flag combination
// (shortest = clearest minimal reproduction).
const flagKey = (v) => [
  v.final.staleCharge ? 'stale' : '',
  v.final.lostPostSnapWrites.length > 0 ? 'lost' : '',
  v.final.charged.some((c) => c.some((k) => v.final.expired.includes(k)))
    ? 'expired'
    : '',
].filter(Boolean).join('+') || 'clean'

const seen = new Set()
const unique = vectors.filter((v) => !seen.has(v.signature) && seen.add(v.signature))
const byFlag = new Map()
for (const v of unique) {
  const k = flagKey(v)
  const bucket = byFlag.get(k) ?? []
  if (bucket.length < 5) bucket.push(v)
  else {
    const longest = bucket.reduce((a, b) => (a.events.length > b.events.length ? a : b))
    if (v.events.length < longest.events.length)
      bucket[bucket.indexOf(longest)] = v
  }
  byFlag.set(k, bucket)
}
const boundary = [...byFlag.entries()]
  .filter(([k]) => k !== 'clean')
  .flatMap(([, vs]) => vs)
const happy = (byFlag.get('clean') ?? []).slice(0, 8)
const kept = [...boundary, ...happy]

kept.forEach((v, i) => {
  const name = `ec-${String(i).padStart(3, '0')}`
  writeFileSync(
    join(outDir, `${name}.json`),
    JSON.stringify({ name, events: v.events, final: v.final }, null, 1) + '\n',
  )
})
console.log(
  `wrote ${kept.length} vectors to ${outDir} ` +
    `(${boundary.length} boundary, ${happy.length} quiescent, from ${vectors.length} traces)`,
)
