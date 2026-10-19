#!/usr/bin/env node
// dshx-token-cost — offline reporter.
//
// Prints the same per-day / per-model / grand-total view the settings panel
// renders, but from a terminal, so the numbers can be eyeballed without
// restarting the app. It imports the real `usage.js` and `pricing.js` rather
// than re-implementing them, so a bug in either shows up here.
//
// `test-endpoint.mjs` is the one with assertions; this script is for looking
// at the output. It also prints scan diagnostics, which is how the two layout
// traps documented in `usage.js` were found.
//
// Run:  node test.mjs [days]

import { promises as fs } from 'node:fs'

import {
  DAY_MS,
  dayKey,
  decodeLog,
  dshHome,
  emptyBucket,
  foldSessionText,
  scanSessionFiles,
  todayStart,
  totalOf,
  windowStart,
} from './usage.js'

import { PRICES_AS_OF, USD_TO_CNY, costOf, rateFor } from './pricing.js'

const DAYS = Number(process.argv[2]) > 0 ? Math.round(Number(process.argv[2])) : 14
const home = dshHome()
const nf = new Intl.NumberFormat('en-US')
const money = (n) => n.toFixed(2)

console.log('dshx-token-cost offline reporter')
console.log(`  DSH_HOME     ${home}`)
console.log(`  window       ${dayKey(windowStart(DAYS))} -> ${dayKey(todayStart())}  (${DAYS} days)`)
console.log(`  prices as of ${PRICES_AS_OF}, USD->CNY ${USD_TO_CNY}`)
console.log('')

// ---- scan -----------------------------------------------------------------

const scanStarted = Date.now()
const files = await scanSessionFiles(home)
console.log(`scan: ${files.size} sessions in ${Date.now() - scanStarted} ms`)

const revisions = new Map()
for (const info of files.values()) {
  revisions.set(info.revision, (revisions.get(info.revision) ?? 0) + 1)
}
console.log('  revisions kept: '
  + [...revisions].sort((a, b) => a[0] - b[0])
    .map(([rev, count]) => `v${rev}=${count}`).join('  '))

// ---- fold -----------------------------------------------------------------

const foldStarted = Date.now()
const byDay = new Map()
let attributed = 0
let orphan = 0
let failed = 0
for (const info of files.values()) {
  let text
  try {
    text = decodeLog(await fs.readFile(info.path))
  } catch {
    failed += 1
    continue
  }
  const result = foldSessionText(text, byDay)
  attributed += result.attributed
  orphan += result.orphan
}
console.log(`fold: ${attributed} messages attributed, ${orphan} without a header, `
  + `${failed} unreadable, ${Date.now() - foldStarted} ms`)
console.log('')

// ---- price ----------------------------------------------------------------

const sinceDay = dayKey(windowStart(DAYS))
const rows = []
const modelTotals = new Map()
const unpriced = new Set()
let grandCost = 0
let grandTokens = 0
let grandCalls = 0

for (let offset = 0; offset < DAYS; offset += 1) {
  const key = dayKey(todayStart() - offset * DAY_MS)
  const buckets = byDay.get(key)
  if (buckets === undefined) continue

  const models = []
  let dayCost = 0
  let dayTokens = 0
  let dayCalls = 0

  for (const [label, bucket] of buckets) {
    const sample = bucket.routes[0] ?? ''
    const split = sample.indexOf('/')
    const rate = rateFor(split < 0 ? sample : sample.slice(0, split),
      split < 0 ? sample : sample.slice(split + 1))
    if (rate.unpriced === true) unpriced.add(label)
    const cost = costOf(rate, bucket)
    const total = totalOf(bucket)
    models.push({ label, ...bucket, cost, total })

    let rollup = modelTotals.get(label)
    if (rollup === undefined) {
      rollup = { label, ...emptyBucket(label), cost: 0, total: 0 }
      modelTotals.set(label, rollup)
    }
    rollup.input += bucket.input
    rollup.output += bucket.output
    rollup.cacheRead += bucket.cacheRead
    rollup.cacheWrite += bucket.cacheWrite
    rollup.reasoning += bucket.reasoning
    rollup.calls += bucket.calls
    rollup.cost += cost
    rollup.total += total

    dayCost += cost
    dayTokens += total
    dayCalls += bucket.calls
  }

  models.sort((a, b) => b.cost - a.cost)
  rows.push({ date: key, models, cost: dayCost, tokens: dayTokens, calls: dayCalls })
  grandCost += dayCost
  grandTokens += dayTokens
  grandCalls += dayCalls
}

console.log('=== per day ===')
for (const day of rows) {
  console.log(`\n${day.date}   $${money(day.cost)}   ~ CNY ${money(day.cost * USD_TO_CNY)}   `
    + `${nf.format(day.tokens)} tok   ${day.calls} calls`)
  for (const m of day.models) {
    console.log(`    ${m.label.padEnd(24)} ${nf.format(m.total).padStart(13)} tok  `
      + `in ${nf.format(m.input).padStart(9)}  out ${nf.format(m.output).padStart(8)}  `
      + `cacheR ${nf.format(m.cacheRead).padStart(10)}  cacheW ${nf.format(m.cacheWrite).padStart(9)}  `
      + `$${money(m.cost).padStart(8)}`)
  }
}

console.log('\n=== totals by model ===')
for (const m of [...modelTotals.values()].sort((a, b) => b.cost - a.cost)) {
  console.log(`${m.label.padEnd(26)} ${nf.format(m.total).padStart(14)} tok  `
    + `${String(m.calls).padStart(6)} calls  $${money(m.cost).padStart(9)}  `
    + `CNY ${money(m.cost * USD_TO_CNY).padStart(9)}`)
}

console.log('\n=== grand total ===')
console.log(`  tokens   ${nf.format(grandTokens)}`)
console.log(`  calls    ${nf.format(grandCalls)}`)
console.log(`  cost     $${money(grandCost)}   ~ CNY ${money(grandCost * USD_TO_CNY)}`)
console.log(`  since    ${sinceDay}`)
if (unpriced.size > 0) console.log(`  UNPRICED: ${[...unpriced].join(', ')}`)
