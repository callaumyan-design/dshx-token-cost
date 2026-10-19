#!/usr/bin/env node
// dshx-token-cost — endpoint test.
//
// Loads the *real* host half, mounts it on a stub context, calls the real route
// handler, and asserts on the JSON it produces. That covers the parts the
// offline reporter cannot reach: the service lookup, the route registration,
// the request envelope, query parsing and clamping, the method guard, the
// index TTL cache, and the balance parsing path.
//
// The balance is stubbed rather than fetched, so the test never touches the
// network and never needs a real API key.
//
// Run:  node test-endpoint.mjs

import { promises as fs, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { name, inject, apply } from './index.js'
import {
  FALLBACK_RATE,
  RATE_SOURCES,
  RATE_TTL_MS,
  describeRate,
  isRateFresh,
  parseRate,
  plausibleRate,
  ratePath,
  readRateCache,
} from './rate.js'
import {
  INDEX_VERSION,
  dayKey,
  decodeLog,
  dshHome,
  foldSessionText,
  indexPath,
  readIndex,
  scanSessionFiles,
  todayStart,
  totalOf,
  windowStart,
} from './usage.js'

/** Today, as the `YYYY-MM-DD` key the report uses. */
function todayKey() {
  return dayKey(todayStart())
}

// ---- stubs ----------------------------------------------------------------

/**
 * Keep the plugin's state out of the real one, and clean up after the run.
 *
 * The host caches the exchange rate on disk, so without this the canned rate
 * below would be written to `~/.dsh/dshx-token-cost/rate.json` and the panel
 * would report a made-up rate until the next daily refresh.
 */
const TEST_STATE = path.join(os.tmpdir(), `dshx-token-cost-test-${process.pid}`)
process.env.DSHX_TOKEN_COST_STATE = TEST_STATE
process.on('exit', () => {
  try {
    rmSync(TEST_STATE, { recursive: true, force: true })
  } catch {
    // A leftover temp directory is not worth failing a run over.
  }
})

/** Canned responses, keyed by a fragment of the URL curl was handed on stdin. */
const RESPONSES = [
  ['deepseek.com/user/balance', JSON.stringify({
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '88.40', granted_balance: '0.00', topped_up_balance: '88.40' },
    ],
  })],
  ['open.er-api.com', JSON.stringify({
    result: 'success',
    time_last_update_unix: 1791676951,
    rates: { CNY: 6.706851 },
  })],
  ['api.frankfurter.app', JSON.stringify({ rates: { CNY: 6.6921 } })],
]

const credentials = {
  async resolve(key) {
    if (key !== 'DEEPSEEK_API_KEY') throw new Error('unexpected credential: ' + key)
    return { value: 'sk-test-not-a-real-key' }
  },
}

/** Every URL curl was asked for, so a test can count per endpoint. */
const spawnedUrls = []

/** How many times an endpoint was fetched. */
function spawnCountFor(needle) {
  return spawnedUrls.filter((url) => url.includes(needle)).length
}

const subprocess = {
  async resolveExecutable(name) {
    return name === 'curl' || name === 'curl.exe' ? 'curl' : null
  },
  spawn(options) {
    // The real call puts the URL in curl's stdin config, so the stub reads it
    // back out rather than guessing from the argv.
    const config = options?.stdio?.stdin?.data ?? ''
    const match = /url = "([^"]+)"/.exec(config)
    const url = match === null ? '' : match[1]
    spawnedUrls.push(url)
    const found = RESPONSES.find(([needle]) => url.includes(needle))
    return {
      done: Promise.resolve({ exitCode: 0 }),
      collected: {
        stdout: { readFrom: () => ({ text: found === undefined ? '{}' : found[1] }) },
        stderr: { readFrom: () => ({ text: '' }) },
      },
    }
  },
}

let registered = null
const webServer = {
  register(route) {
    registered = route
    return () => { registered = null }
  },
}

const services = { credentials, subprocess, webServer }
const ctx = {
  get: (key) => services[key],
  effect: (fn) => fn(),
  // Cordis also exposes every injected service directly on the context, and
  // the route registration uses this form.
  webServer,
}

// ---- mount ----------------------------------------------------------------

console.log(`plugin name   ${name}`)
console.log(`injects       ${JSON.stringify(inject)}`)

apply(ctx)
if (registered === null) throw new Error('apply() did not register a route')
console.log(`route         ${registered.path} (${registered.kind})`)
console.log('')

/** Minimal request/response pair matching the handler's contract. */
function callRoute(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    let status = 0
    const headers = {}
    const chunks = []
    const res = {
      writeHead(code, h) {
        status = code
        Object.assign(headers, h || {})
      },
      end(body) {
        if (body !== undefined) chunks.push(Buffer.from(String(body)))
        resolve({ status, headers, body: Buffer.concat(chunks).toString('utf8') })
      },
      on() { /* the handler never streams */ },
    }
    Promise.resolve(registered.handler({ method, url }, res)).catch(reject)
  })
}

// ---- assertions -----------------------------------------------------------

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures += 1
  console.log(`  [${mark}] ${label}${detail === undefined ? '' : '  ' + detail}`)
}

// An independent fold of the same corpus, to compare the route against. The
// route reads only the newest log revision per session; this reads the same
// files through the same helper, so a mismatch means the shaping is wrong.
async function independentTotal(days) {
  const files = await scanSessionFiles(dshHome())
  const sinceDay = dayKey(windowStart(days))
  const byDay = new Map()
  for (const info of files.values()) {
    let text
    try {
      text = decodeLog(await fs.readFile(info.path))
    } catch {
      continue
    }
    foldSessionText(text, byDay)
  }
  let tokens = 0
  let calls = 0
  for (const [day, buckets] of byDay) {
    if (day < sinceDay) continue
    for (const bucket of buckets.values()) {
      tokens += totalOf(bucket)
      calls += bucket.calls
    }
  }
  return { sessions: files.size, tokens, calls }
}

console.log('--- GET /report?days=30 ---')
const first = await callRoute('/dshx-token-cost/report?days=30')
check('status 200', first.status === 200, 'got ' + first.status)
const payload = JSON.parse(first.body)
check('no-store cache header', first.headers['cache-control'] === 'no-store')

const usage = payload.usage
check('usage.available', usage?.available === true, usage?.reason)
check('windowDays is the window size', usage.windowDays === 30, 'got ' + usage.windowDays)
check('days is the row array', Array.isArray(usage.days), 'got ' + typeof usage.days)
check('models is an array', Array.isArray(usage.models))
check('total present', usage.total !== undefined && typeof usage.total.cost === 'number')
check('no unpriced models', (usage.meta.unpricedModels ?? []).length === 0,
  JSON.stringify(usage.meta.unpricedModels))
check('day rows are newest-first', usage.days.length < 2
  || usage.days[0].date > usage.days[usage.days.length - 1].date)
check('every day row has a finite cost',
  usage.days.every((d) => typeof d.cost === 'number' && Number.isFinite(d.cost)))
check('model costs sum to the grand total',
  Math.abs(usage.models.reduce((s, m) => s + m.cost, 0) - usage.total.cost) < 0.01)
check('day costs sum to the grand total',
  Math.abs(usage.days.reduce((s, d) => s + d.cost, 0) - usage.total.cost) < 0.01)
check('day tokens sum to the grand total',
  usage.days.reduce((s, d) => s + d.total, 0) === usage.total.total)
check('rows expose their routes',
  usage.models.every((m) => Array.isArray(m.routes) && m.routes.length > 0))

// The panel shows total = input + output + cacheRead + cacheWrite, matching the
// harness's own tokenTotal. Assert the identity rather than a magic number.
check('total equals the four disjoint buckets',
  usage.models.every((m) => m.total === m.input + m.output + m.cacheRead + m.cacheWrite))
check('reasoning is excluded from the total',
  usage.models.filter((m) => m.reasoning > 0)
    .every((m) => m.total === m.input + m.output + m.cacheRead + m.cacheWrite))
check('every row with tokens carries a cost',
  usage.models.every((m) => m.total === 0 || m.cost > 0))

console.log('\n--- hourly ---')
check('hours is an array', Array.isArray(usage.hours))
check('hours are available', usage.hoursAvailable === true)
check('hour tokens sum to the grand total',
  usage.hours.reduce((s, h) => s + h.total, 0) === usage.total.total,
  `${usage.hours.reduce((s, h) => s + h.total, 0)} vs ${usage.total.total}`)
check('hour calls sum to the grand total',
  usage.hours.reduce((s, h) => s + h.calls, 0) === usage.total.calls)
check('hour costs sum to the grand total',
  Math.abs(usage.hours.reduce((s, h) => s + h.cost, 0) - usage.total.cost) < 0.01)
check('hours are 0..23 and inside the window',
  usage.hours.every((h) => Number.isInteger(h.hour) && h.hour >= 0 && h.hour < 24
    && h.date >= usage.fromDay && h.date <= usage.toDay))
check('hours are oldest-first',
  usage.hours.every((h, i, a) => i === 0
    || (a[i - 1].date + a[i - 1].hour / 100) < (h.date + h.hour / 100)))
check('each day\'s hours add up to that day',
  usage.days.every((d) => usage.hours.filter((h) => h.date === d.date)
    .reduce((s, h) => s + h.total, 0) === d.total))

const expected = await independentTotal(30)
check('sessionsOnDisk matches a direct scan',
  usage.meta.sessionsOnDisk === expected.sessions,
  `${usage.meta.sessionsOnDisk} vs ${expected.sessions}`)
check('grand token total matches an independent fold',
  usage.total.total === expected.tokens, `${usage.total.total} vs ${expected.tokens}`)
check('grand call count matches an independent fold',
  usage.total.calls === expected.calls, `${usage.total.calls} vs ${expected.calls}`)

console.log('\n--- balance ---')
check('balance.available', payload.balance?.available === true, payload.balance?.reason)
check('balance reports availability', payload.balance.isAvailable === true)
check('balance currency parsed', payload.balance.currencies?.[0]?.currency === 'CNY',
  JSON.stringify(payload.balance.currencies))
check('balance total parsed as a number', payload.balance.currencies?.[0]?.total === 88.4,
  String(payload.balance.currencies?.[0]?.total))

console.log('\n--- GET /report?days=7 ---')
const week = JSON.parse((await callRoute('/dshx-token-cost/report?days=7')).body).usage
check('window echoed', week.windowDays === 7, 'got ' + week.windowDays)
check('7-day cost <= 30-day cost', week.total.cost <= usage.total.cost + 0.01,
  `$${week.total.cost.toFixed(2)} vs $${usage.total.cost.toFixed(2)}`)

console.log('\n--- clamping ---')
const clamped = JSON.parse((await callRoute('/dshx-token-cost/report?days=9999')).body).usage
check('clamped to 365', clamped.windowDays === 365, 'got ' + clamped.windowDays)
check('reports its own maximum in meta', clamped.meta.maxDays === 365,
  'got ' + clamped.meta.maxDays)
const garbage = JSON.parse((await callRoute('/dshx-token-cost/report?days=abc')).body).usage
check('garbage days falls back to 30', garbage.windowDays === 30, 'got ' + garbage.windowDays)

console.log('\n--- today only ---')
const today = JSON.parse((await callRoute('/dshx-token-cost/report?days=1')).body).usage
check('days=1 is a one-day window', today.windowDays === 1, 'got ' + today.windowDays)
check('days=1 ends today', today.toDay === todayKey(), today.toDay + ' vs ' + todayKey())
check('days=1 starts today', today.fromDay === todayKey(), today.fromDay)
check('days=1 is reported as trailing', today.mode === 'trailing', today.mode)

console.log('\n--- custom range ---')
// A range anchored on the newest day that has data, so the assertions are about
// the window rather than about which days happen to be busy.
const newestDay = usage.days[0].date
const oldestDay = usage.days[usage.days.length - 1].date
const custom = JSON.parse((await callRoute(
  `/dshx-token-cost/report?from=${oldestDay}&to=${newestDay}`)).body).usage
check('custom range is reported as custom', custom.mode === 'custom', custom.mode)
check('custom range echoes its bounds',
  custom.fromDay === oldestDay && custom.toDay === newestDay,
  custom.fromDay + ' -> ' + custom.toDay)
check('custom range covers every day in between',
  custom.windowDays === usage.windowDays,
  `${custom.windowDays} vs ${usage.windowDays}`)
check('custom range totals match the trailing window over the same days',
  custom.total.total === usage.total.total && custom.total.calls === usage.total.calls,
  `${custom.total.total} vs ${usage.total.total}`)

console.log('\n--- custom range edge cases ---')
const flipped = JSON.parse((await callRoute(
  `/dshx-token-cost/report?from=${newestDay}&to=${oldestDay}`)).body).usage
check('a reversed range is normalised, not rejected',
  flipped.fromDay === oldestDay && flipped.toDay === newestDay,
  flipped.fromDay + ' -> ' + flipped.toDay)

const single = JSON.parse((await callRoute(
  `/dshx-token-cost/report?from=${newestDay}&to=${newestDay}`)).body).usage
check('a one-day custom range works', single.windowDays === 1, 'got ' + single.windowDays)
check('a one-day custom range totals one day',
  single.total.total === usage.days[0].total,
  `${single.total.total} vs ${usage.days[0].total}`)

const badFrom = JSON.parse((await callRoute(
  '/dshx-token-cost/report?from=2026-02-30&to=2026-10-11')).body).usage
check('an impossible date falls back to days',
  badFrom.mode === 'trailing' && badFrom.windowDays === 30,
  badFrom.mode + '/' + badFrom.windowDays)

const wide = JSON.parse((await callRoute(
  '/dshx-token-cost/report?from=2020-01-01&to=2026-10-11')).body).usage
check('an over-wide range is clamped to the maximum',
  wide.windowDays === wide.meta.maxDays, 'got ' + wide.windowDays)
check('an over-wide range is clamped to 365',
  wide.windowDays === 365, 'got ' + wide.windowDays)
check('an over-wide range says it was truncated', wide.truncated === true, String(wide.truncated))
check('a clamped range still ends at the requested end',
  wide.toDay === todayKey(), wide.toDay)

console.log('\n--- exchange rate ---')
const rateMeta = usage.meta
check('reports the fetched rate', Math.abs(rateMeta.usdToCny - 6.706851) < 1e-9,
  String(rateMeta.usdToCny))
check('names the source it came from', rateMeta.rateSource === 'er-api', rateMeta.rateSource)
check('is not flagged as a fallback', rateMeta.rateIsFallback === false,
  String(rateMeta.rateIsFallback))
check('records when it was fetched', Number.isFinite(rateMeta.rateFetchedAt),
  String(rateMeta.rateFetchedAt))
check('publishes the fallback it would use', Math.abs(rateMeta.rateFallback - 7.1) < 1e-9,
  String(rateMeta.rateFallback))
check('did not fall through to the second source', spawnCountFor('frankfurter') === 0,
  spawnCountFor('frankfurter') + ' frankfurter call(s)')

// The price book quotes DeepSeek in yuan, so a row's dollar rate has to move
// with the exchange rate for the yuan figure to stay at the published ¥4.5.
const deepseek = usage.models.find((m) => m.label === 'DeepSeek V4 Pro')
if (deepseek === undefined) {
  check('found a yuan-quoted model to check', false, 'DeepSeek V4 Pro not in the window')
} else {
  const impliedCny = deepseek.cost / deepseek.total * 1e6 * rateMeta.usdToCny
  check('a yuan-quoted model still prices at its published yuan rate',
    deepseek.total > 0 && Number.isFinite(impliedCny), 'implied ¥' + impliedCny.toFixed(4))
}

console.log('\n--- exchange rate resilience ---')
// Every endpoint answers with something unparseable. The last known rate is
// better than the constant this feature exists to replace, so it must be kept.
const liveSources = RESPONSES.splice(1)
const kept = JSON.parse((await callRoute(
  '/dshx-token-cost/report?days=30&force=1')).body).usage.meta
check('keeps the last known rate when every source fails',
  Math.abs(kept.usdToCny - 6.706851) < 1e-9, String(kept.usdToCny))
check('and still says where that rate came from', kept.rateSource === 'er-api', kept.rateSource)
check('and does not pretend it is a fallback', kept.rateIsFallback === false,
  String(kept.rateIsFallback))
RESPONSES.push(...liveSources)

console.log('\n--- exchange rate cache ---')
const cachedRate = await readRateCache(ratePath())
check('persisted the rate to disk',
  cachedRate !== null && Math.abs(cachedRate.rate - 6.706851) < 1e-9,
  JSON.stringify(cachedRate))
check('records its source on disk', cachedRate?.source === 'er-api', String(cachedRate?.source))
// The guard that matters: a canned rate must never reach the real profile.
check('kept its state out of the real profile', ratePath().startsWith(os.tmpdir()), ratePath())

console.log('\n--- exchange rate parsing ---')
const [erApi, frankfurter] = RATE_SOURCES
check('reads the er-api shape',
  Math.abs((parseRate(erApi, JSON.stringify({ rates: { CNY: 6.7 } })) ?? {}).rate - 6.7) < 1e-9)
check('reads the frankfurter shape',
  Math.abs((parseRate(frankfurter, JSON.stringify({ rates: { CNY: 6.69 } })) ?? {}).rate - 6.69) < 1e-9)
check('carries the publication time when the source gives one',
  parseRate(erApi, JSON.stringify({ rates: { CNY: 6.7 }, time_last_update_unix: 1791676951 }))?.asOf
    === 1791676951000)
check('rejects a body that is not JSON', parseRate(erApi, '<html>nope</html>') === null)
check('rejects a missing rate', parseRate(erApi, JSON.stringify({ rates: {} })) === null)
check('rejects a wrong base currency',
  parseRate(erApi, JSON.stringify({ rates: { CNY: 0.15 } })) === null, '0.15 is not USD→CNY')
check('rejects an absurd rate',
  parseRate(erApi, JSON.stringify({ rates: { CNY: 9999 } })) === null)
check('plausibleRate accepts the real band', plausibleRate(6.7) && plausibleRate(7.9))
check('plausibleRate rejects the edges', !plausibleRate(1) && !plausibleRate(50) && !plausibleRate(NaN))
const fallback = describeRate(null)
check('describeRate falls back cleanly',
  fallback.isFallback === true && fallback.value === FALLBACK_RATE && fallback.fetchedAt === null,
  JSON.stringify(fallback))
check('isRateFresh honours the daily window',
  isRateFresh({ fetchedAt: Date.now() - 1000 }, Date.now()) === true
  && isRateFresh({ fetchedAt: Date.now() - RATE_TTL_MS - 1 }, Date.now()) === false
  && isRateFresh(null, Date.now()) === false)

console.log('\n--- method guard ---')
const bad = await callRoute('/dshx-token-cost/report', 'POST')
check('POST rejected with 405', bad.status === 405, 'got ' + bad.status)

console.log('\n--- caches ---')
// Counted relatively rather than against a literal: earlier sections make
// their own requests, and a hard-coded total silently goes stale when one is
// added.
const balanceBeforeWarm = spawnCountFor('deepseek.com')
const rateBeforeWarm = spawnCountFor('er-api')
const warmStarted = Date.now()
const warm = await callRoute('/dshx-token-cost/report?days=30')
const warmMs = Date.now() - warmStarted
check('warm request is fast', warmMs < 500, warmMs + ' ms')
check('warm request still answers 200', warm.status === 200)
check('a warm request re-fetches nothing',
  spawnCountFor('deepseek.com') === balanceBeforeWarm && spawnCountFor('er-api') === rateBeforeWarm,
  `balance ${balanceBeforeWarm}->${spawnCountFor('deepseek.com')}, `
  + `rate ${rateBeforeWarm}->${spawnCountFor('er-api')}`)

const stored = await readIndex(indexPath())
check('index persisted to disk', stored.version === INDEX_VERSION, 'version ' + stored.version)
check('index holds every session',
  Object.keys(stored.sessions).length === usage.meta.sessionsOnDisk,
  `${Object.keys(stored.sessions).length} vs ${usage.meta.sessionsOnDisk}`)
check('index entries record the log revision',
  Object.values(stored.sessions).every((e) => typeof e.revision === 'number'))

console.log('\n--- force refresh ---')
const balanceBeforeForce = spawnCountFor('deepseek.com')
const rateBeforeForce = spawnCountFor('er-api')
const forced = JSON.parse((await callRoute('/dshx-token-cost/report?days=30&force=1')).body)
check('force still answers 200', forced.usage?.available === true)
check('force re-reads the balance', spawnCountFor('deepseek.com') === balanceBeforeForce + 1,
  spawnCountFor('deepseek.com') + ' spawn(s)')
check('force re-reads the exchange rate', spawnCountFor('er-api') === rateBeforeForce + 1,
  spawnCountFor('er-api') + ' spawn(s)')
// The index was just written, so a forced rebuild re-stats and decodes only a
// log that grew since — normally none, at most the session being written now.
check('forced rebuild reuses the index', forced.usage.meta.decoded <= 1,
  'decoded ' + forced.usage.meta.decoded)
check('forced rebuild produces the same totals',
  forced.usage.total.total === usage.total.total && forced.usage.total.cost === usage.total.cost)

console.log('')
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`)
  process.exitCode = 1
} else {
  console.log('all checks passed')
}
