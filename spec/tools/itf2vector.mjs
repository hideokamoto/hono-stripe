#!/usr/bin/env node
// Convert Quint ITF/MBT traces (--out-itf --mbt) into compact test vectors.
//
// Usage:
//   quint run spec/quint/billing_sync_2ev.qnt --mbt \
//     --out-itf=/tmp/traces/t_{#}.itf.json --n-traces=200 --max-steps=12
//   node spec/tools/itf2vector.mjs /tmp/traces test/fixtures/sync
//
// Output: one JSON per distinct action schedule that reaches quiescence:
//   { name, policy, storeAtomic, snapshots, events, final }
// where `events` is the schedule replayed by the test harness:
//   emit | deliver1|deliver2 | finish1|finish2 | begin1|begin2 | commit1|commit2
// (atomic finishes fold begin+commit; the KV phases stay explicit).

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

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
  'emit', 'deliver1', 'deliver2',
  'finishAtomic1', 'finishAtomic2',
  'beginFinish1', 'beginFinish2',
  'commitFinish1', 'commitFinish2',
]
// Unified names for the harness: atomic finish = finish, KV = begin+commit.
const ACTION = {
  emit: 'emit',
  deliver1: 'deliver1', deliver2: 'deliver2',
  finishAtomic1: 'finish1', finishAtomic2: 'finish2',
  beginFinish1: 'begin1', beginFinish2: 'begin2',
  commitFinish1: 'commit1', commitFinish2: 'commit2',
}

const srcDir = process.argv[2]
const outDir = process.argv[3]
if (!srcDir || !outDir) {
  console.error('usage: itf2vector.mjs <traces-dir> <out-dir>')
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

const vectors = []
for (const f of readdirSync(srcDir).filter((f) => f.endsWith('.itf.json'))) {
  let states
  try {
    states = JSON.parse(readFileSync(join(srcDir, f), 'utf8')).states
  } catch {
    continue
  }
  if (!states?.length) continue

  const policy = dec(states[0].policy) ?? dec(states[1]?.policy)
  const storeAtomic = dec(states[states.length - 1].storeAtomic)

  const events = []
  const snapshots = {}
  let ok = true
  for (let i = 1; i < states.length; i++) {
    const which = dec(states[i]['mbt::nondetPicks']?.which)
    if (which === null || which === undefined) continue
    const action = ACTION[WHICH[which]]
    const s = states[i]
    events.push(action)
    if (action === 'deliver1') snapshots[1] = dec(s.snap1)
    if (action === 'deliver2') snapshots[2] = dec(s.snap2)
    // Skip dead transitions (noop) — a which-pick whose guard failed.
    const prev = states[i - 1]
    const changed =
      dec(s.truth) !== dec(prev.truth) ||
      JSON.stringify(dec(s.pending)) !== JSON.stringify(dec(prev.pending)) ||
      JSON.stringify(dec(s.inflight)) !== JSON.stringify(dec(prev.inflight)) ||
      JSON.stringify(dec(s.seen)) !== JSON.stringify(dec(prev.seen)) ||
      dec(s.mirrorVersion) !== dec(prev.mirrorVersion) ||
      dec(s.chk1) !== dec(prev.chk1) ||
      dec(s.chk2) !== dec(prev.chk2)
    if (!changed) events.pop()
  }
  const last = states[states.length - 1]
  const final = {
    truth: dec(last.truth),
    mirrorVersion: dec(last.mirrorVersion),
    mirrorCreated: dec(last.mirrorCreated),
    quiescent:
      dec(last.truth) === 2 && dec(last.pending).length === 0 && dec(last.inflight).length === 0,
  }
  // Keep only schedules that reached quiescence — the property under test.
  if (!final.quiescent || !ok) continue

  vectors.push({
    policy,
    storeAtomic,
    snapshots,
    events,
    final,
    signature: events.join(','),
  })
}

// Deduplicate by schedule; keep the first occurrence.
const seen = new Set()
const unique = vectors.filter((v) => !seen.has(v.signature) && seen.add(v.signature))

const files = []
unique.forEach((v, i) => {
  const name = `sync-${String(i).padStart(3, '0')}`
  const file = `${name}.json`
  writeFileSync(
    join(outDir, file),
    JSON.stringify({ name, ...v, signature: undefined }, null, 1) + '\n',
  )
  files.push(file)
})
console.log(`wrote ${files.length} vectors to ${outDir} (from ${vectors.length} quiescent traces)`)
