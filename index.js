// dshx-token-cost — host half.
//
// Serves one JSON endpoint that the browser half renders in Settings:
//
//   GET /dshx-token-cost/report?days=30[&force=1]
//
// It answers two questions that used to live in two separate plugins:
//
//   * the DeepSeek account balance, read from the credentialed platform API;
//   * how many tokens this machine spent, per day and per model, and what that
//     would have cost on metered API billing.
//
// ## Why it does not go through `sessionQuery`
// It used to, and that is what broke it. See the header of `usage.js`: the
// service replays and validates each log on every read, which costs ~0.2 s per
// session and turned a 250-session corpus into a 50–90 second request. The
// panel sat on "读取中" and looked dead. Reading the logs directly is ~5 s cold
// and, with the persistent index, milliseconds warm.
//
// ## Warming
// The index is built once when the plugin loads, in the background, so the
// first time the settings page is opened the numbers are already there. A
// refresh re-stats the corpus and decodes only logs that changed.

import { promises as fs } from 'node:fs'

import {
  INDEX_KEEP_DAYS,
  dayKey,
  dayStart,
  daysBetween,
  decodeLog,
  describeError,
  dshHome,
  emptyBucket,
  foldSessionText,
  indexPath,
  isDayKey,
  previousDay,
  pruneIndex,
  readIndex,
  scanSessionFiles,
  serializeDays,
  serializeHours,
  todayStart,
  totalOf,
  writeIndex,
} from './usage.js'

import { PEAK_MULTIPLIER, PRICES_AS_OF, USD_TO_CNY, costOf, rateFor } from './pricing.js'

import {
  RATE_SOURCES,
  describeRate,
  isRateFresh,
  parseRate,
  ratePath,
  readRateCache,
  writeRateCache,
} from './rate.js'

/** Stable Cordis plugin name. */
export const name = 'dshx-token-cost'

/** The webserver carrier must exist before routes can be registered. */
export const inject = ['webServer']

/** Route path of the report endpoint. */
const ROUTE = '/dshx-token-cost/report'

/**
 * Days of history the endpoint will answer for at most.
 *
 * Capped by {@link INDEX_KEEP_DAYS} as well, because that is what the index
 * retains — asking for more could only come back with empty days. Keeping the
 * `min` here means the two cannot drift into a window the index cannot fill.
 */
const MAX_DAYS = Math.min(365, INDEX_KEEP_DAYS)

/** The window a request gets when it asks for nothing. */
const DEFAULT_DAYS = 30

/**
 * How long a built index is reused before the corpus is re-statted. A stat
 * pass is cheap, but there is no reason to do one per keystroke.
 */
const INDEX_TTL_MS = 10000

/** The balance endpoint is a network call; a page refresh must not hammer it. */
const BALANCE_TTL_MS = 120000

/** The in-flight build, so concurrent requests share one pass. */
let inflight = null

/** The last built index and when it was built. */
let cached = null

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

// ---------------------------------------------------------------------------
// index building
// ---------------------------------------------------------------------------

/**
 * Bring the on-disk index up to date with the corpus.
 *
 * A session log is append-only, so `(size, mtimeMs)` identifies its contents.
 * A session whose pair is unchanged is reused verbatim; only new or growing
 * logs are decoded. Sessions whose log has disappeared are dropped.
 *
 * @returns {index, stats} — the fresh index and what the pass cost.
 */
async function buildIndex() {
  const started = Date.now()
  const home = dshHome()
  const file = indexPath()

  const index = await readIndex(file)
  const files = await scanSessionFiles(home)

  const changed = []
  for (const [id, info] of files) {
    const prev = index.sessions[id]
    if (prev !== undefined && prev.size === info.size && prev.mtimeMs === info.mtimeMs) continue
    changed.push([id, info])
  }

  let removed = 0
  for (const id of Object.keys(index.sessions)) {
    if (!files.has(id)) {
      delete index.sessions[id]
      removed += 1
    }
  }

  let decoded = 0
  let failed = 0
  for (const [id, info] of changed) {
    let text
    try {
      text = decodeLog(await fs.readFile(info.path))
    } catch {
      failed += 1
      continue
    }
    const byDay = new Map()
    const byHour = new Map()
    foldSessionText(text, byDay, byHour)
    index.sessions[id] = {
      size: info.size,
      mtimeMs: info.mtimeMs,
      revision: info.revision,
      days: serializeDays(byDay),
      hours: serializeHours(byHour),
    }
    decoded += 1
  }

  pruneIndex(index, INDEX_KEEP_DAYS, Date.now())

  if (decoded > 0 || removed > 0) {
    index.builtAt = Date.now()
    try {
      await writeIndex(file, index)
    } catch {
      // An unwritable state directory costs speed, not correctness: the next
      // pass simply rebuilds.
    }
  }

  return {
    index,
    stats: {
      sessionsOnDisk: files.size,
      sessionsIndexed: Object.keys(index.sessions).length,
      decoded,
      failed,
      removed,
      indexBuiltAt: index.builtAt,
      scanMs: Date.now() - started,
    },
  }
}

/**
 * Return a current index, reusing the last one while it is fresh and
 * serialising concurrent callers onto a single build.
 * @param force - ignore the TTL and re-stat now.
 */
function ensureIndex(force) {
  if (inflight !== null) return inflight
  const now = Date.now()
  if (force !== true && cached !== null && now - cached.at < INDEX_TTL_MS) {
    return Promise.resolve(cached.value)
  }
  const run = buildIndex()
    .then((value) => {
      cached = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      inflight = null
    })
  inflight = run
  return run
}

// ---------------------------------------------------------------------------
// the report
// ---------------------------------------------------------------------------

/** Merge a bucket into a target bucket in place. */
function mergeBucket(target, source) {
  target.input += source.input
  target.output += source.output
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.reasoning += source.reasoning
  target.calls += source.calls
  for (const route of source.routes ?? []) {
    if (!target.routes.includes(route)) target.routes.push(route)
  }
}

/**
 * Price a bucket and shape it into a report row.
 *
 * The bucket is keyed by vendor label, and every route under that label prices
 * the same, so the first route is representative. The route string is
 * `provider/model` and model ids may themselves contain slashes, so the split
 * is on the first slash only.
 */
function toRow(label, bucket, usdToCny) {
  const sample = bucket.routes.length > 0 ? bucket.routes[0] : ''
  const split = sample.indexOf('/')
  const provider = split < 0 ? sample : sample.slice(0, split)
  const model = split < 0 ? sample : sample.slice(split + 1)
  const rate = rateFor(provider, model, usdToCny)
  return {
    label,
    input: bucket.input,
    output: bucket.output,
    cacheRead: bucket.cacheRead,
    cacheWrite: bucket.cacheWrite,
    reasoning: bucket.reasoning,
    total: totalOf(bucket),
    calls: bucket.calls,
    cost: costOf(rate, bucket),
    routes: [...bucket.routes].sort(),
    priced: rate.unpriced !== true,
  }
}

/**
 * A window of `days` days ending today, both ends inclusive.
 * @param days - the requested size; clamped to 1..MAX_DAYS.
 */
function trailingWindow(days) {
  const toDay = dayKey(todayStart())
  const size = Math.min(MAX_DAYS, Math.max(1, Math.round(days)))
  let fromDay = toDay
  for (let step = 1; step < size; step += 1) fromDay = previousDay(fromDay)
  return { fromDay, toDay, mode: 'trailing', truncated: days > MAX_DAYS }
}

/**
 * Read the requested window from a query string.
 *
 * Two forms are accepted, `from`/`to` taking precedence:
 *
 *   ?days=30
 *   ?from=2026-10-01&to=2026-10-11
 *
 * `truncated` travels with the window because clamping happens here: by the
 * time the report walks the range it is already inside the limit, so it can no
 * longer tell that the request asked for more.
 *
 * @returns the window, or null when the query names neither form.
 */
function readWindow(params) {
  const from = params.get('from')
  const to = params.get('to')
  if (isDayKey(from) && isDayKey(to)) {
    const [low, high] = from <= to ? [from, to] : [to, from]
    // A range wider than the report allows is clamped rather than rejected:
    // the most recent MAX_DAYS of it is still the useful answer, and the
    // response says it was truncated.
    const { keys, truncated } = daysBetween(low, high, MAX_DAYS)
    return {
      fromDay: keys.length > 0 ? keys[keys.length - 1] : low,
      toDay: high,
      mode: 'custom',
      truncated,
    }
  }
  const requested = Number(params.get('days'))
  if (Number.isFinite(requested) && requested >= 1) return trailingWindow(requested)
  return null
}

/**
 * Fold the index's per-hour buckets into the hourly chart's series.
 *
 * Only hours that saw at least one call are returned, oldest first; the client
 * fills the gaps itself, which keeps a 365-day response from carrying 8,760
 * mostly-empty rows. Each hour is priced per model and summed, exactly like a
 * day row, so the hours of a day add up to that day's cost.
 *
 * @returns `{ hours: [{date, hour, input, output, cacheRead, cacheWrite,
 *   reasoning, total, calls, cost, models: [{label, total, cost}]}],
 *   hoursAvailable }` — `hoursAvailable` is false when the index predates the
 *   hourly buckets (it is rebuilt on the next pass).
 */
function shapeHours(index, fromDay, toDay, exchange) {
  /** `${day} ${hour}` → Map<label, bucket> */
  const cells = new Map()
  let available = true
  for (const entry of Object.values(index.sessions)) {
    const hourMap = entry?.hours
    if (hourMap === null || typeof hourMap !== 'object') {
      if (entry?.days && Object.keys(entry.days).length > 0) available = false
      continue
    }
    for (const [day, hours] of Object.entries(hourMap)) {
      if (day < fromDay || day > toDay) continue
      for (const [hour, buckets] of Object.entries(hours)) {
        const key = day + ' ' + hour.padStart(2, '0')
        let byLabel = cells.get(key)
        if (byLabel === undefined) {
          byLabel = new Map()
          cells.set(key, byLabel)
        }
        for (const [label, bucket] of Object.entries(buckets)) {
          let target = byLabel.get(label)
          if (target === undefined) {
            target = emptyBucket(label)
            byLabel.set(label, target)
          }
          mergeBucket(target, bucket)
        }
      }
    }
  }

  const rows = []
  for (const key of [...cells.keys()].sort()) {
    const models = [...cells.get(key).entries()]
      .map(([label, b]) => toRow(label, b, exchange.value))
      .sort((a, b) => b.cost - a.cost)
    const sum = (field) => models.reduce((s, m) => s + m[field], 0)
    rows.push({
      date: key.slice(0, 10),
      hour: Number(key.slice(11)),
      input: sum('input'),
      output: sum('output'),
      cacheRead: sum('cacheRead'),
      cacheWrite: sum('cacheWrite'),
      reasoning: sum('reasoning'),
      total: sum('total'),
      calls: sum('calls'),
      cost: sum('cost'),
      models: models.map((m) => ({ label: m.label, total: m.total, calls: m.calls, cost: m.cost })),
    })
  }
  return { hours: rows, hoursAvailable: available }
}

/**
 * Fold the index into a per-day, per-model report for a window of days.
 * @param index - the built index.
 * @param stats - the build statistics, passed through to the client.
 * @param window - `{fromDay, toDay, mode}`, both ends inclusive.
 */
function shapeReport(index, stats, window, exchange) {
  const { fromDay, toDay, mode } = window
  // Walking the calendar rather than adding 86,400,000 ms per day keeps the row
  // list aligned with the day keys the logs were bucketed under across a DST
  // change.
  const { keys, truncated } = daysBetween(fromDay, toDay, MAX_DAYS)

  const byDay = new Map()
  const modelTotals = new Map()
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 }
  const unpriced = new Set()
  const routes = new Set()

  for (const entry of Object.values(index.sessions)) {
    const dayMap = entry?.days
    if (dayMap === null || typeof dayMap !== 'object') continue
    for (const [day, buckets] of Object.entries(dayMap)) {
      if (day < fromDay || day > toDay) continue
      let dayBuckets = byDay.get(day)
      if (dayBuckets === undefined) {
        dayBuckets = new Map()
        byDay.set(day, dayBuckets)
      }
      for (const [label, bucket] of Object.entries(buckets)) {
        for (const route of bucket.routes ?? []) routes.add(route)
        let dayBucket = dayBuckets.get(label)
        if (dayBucket === undefined) {
          dayBucket = emptyBucket(label)
          dayBuckets.set(label, dayBucket)
        }
        mergeBucket(dayBucket, bucket)

        let rollup = modelTotals.get(label)
        if (rollup === undefined) {
          rollup = emptyBucket(label)
          modelTotals.set(label, rollup)
        }
        mergeBucket(rollup, bucket)

        total.input += bucket.input
        total.output += bucket.output
        total.cacheRead += bucket.cacheRead
        total.cacheWrite += bucket.cacheWrite
        total.reasoning += bucket.reasoning
        total.calls += bucket.calls
      }
    }
  }

  const dayRows = []
  for (const key of keys) {
    const buckets = byDay.get(key)
    if (buckets === undefined) continue
    const models = [...buckets.entries()].map(([label, b]) => {
      const row = toRow(label, b, exchange.value)
      if (row.priced !== true) unpriced.add(label)
      return row
    }).sort((a, b) => b.cost - a.cost)
    dayRows.push({
      date: key,
      models,
      input: models.reduce((s, m) => s + m.input, 0),
      output: models.reduce((s, m) => s + m.output, 0),
      cacheRead: models.reduce((s, m) => s + m.cacheRead, 0),
      cacheWrite: models.reduce((s, m) => s + m.cacheWrite, 0),
      reasoning: models.reduce((s, m) => s + m.reasoning, 0),
      total: models.reduce((s, m) => s + m.total, 0),
      calls: models.reduce((s, m) => s + m.calls, 0),
      cost: models.reduce((s, m) => s + m.cost, 0),
    })
  }

  const models = [...modelTotals.entries()].map(([label, b]) => {
    const row = toRow(label, b, exchange.value)
    if (row.priced !== true) unpriced.add(label)
    return row
  }).sort((a, b) => b.cost - a.cost)

  return {
    ...shapeHours(index, fromDay, toDay, exchange),
    available: true,
    mode,
    windowDays: keys.length,
    fromDay: keys.length > 0 ? keys[keys.length - 1] : fromDay,
    toDay,
    // True when a custom range was wider than the report allows and only its
    // most recent MAX_DAYS were returned. The flag is set where the clamping
    // happens, so it is passed through rather than recomputed here.
    truncated: truncated || window.truncated === true,
    since: dayStart(fromDay),
    dayCount: dayRows.length,
    days: dayRows,
    models,
    total: { ...total, total: totalOf(total), cost: models.reduce((s, m) => s + m.cost, 0) },
    meta: {
      pricesAsOf: PRICES_AS_OF,
      usdToCny: exchange.value,
      rateSource: exchange.source,
      rateFetchedAt: exchange.fetchedAt,
      rateIsFallback: exchange.isFallback,
      rateFallback: USD_TO_CNY,
      peakMultiplier: PEAK_MULTIPLIER,
      // Reported so the client can say what the limit is without keeping its
      // own copy of the number.
      maxDays: MAX_DAYS,
      retentionDays: INDEX_KEEP_DAYS,
      unpricedModels: [...unpriced],
      routeCount: routes.size,
      sessionsOnDisk: stats.sessionsOnDisk,
      sessionsIndexed: stats.sessionsIndexed,
      decoded: stats.decoded,
      failed: stats.failed,
      scanMs: stats.scanMs,
      indexBuiltAt: stats.indexBuiltAt,
    },
  }
}

// ---------------------------------------------------------------------------
// outbound requests
// ---------------------------------------------------------------------------

/**
 * Locate curl.
 *
 * It ships with macOS and with Windows 10+, so it is nearly always on PATH;
 * the absolute locations are the fallback for a stripped PATH.
 * @param subprocess the harness's subprocess service.
 * @returns the resolved path, or null.
 */
async function findCurl(subprocess) {
  const candidates = process.platform === 'win32'
    ? ['curl.exe', 'curl', 'C:\\Windows\\System32\\curl.exe']
    : ['curl', '/usr/bin/curl', '/usr/local/bin/curl']
  for (const candidate of candidates) {
    try {
      const resolved = await subprocess.resolveExecutable(candidate)
      if (typeof resolved === 'string' && resolved.length > 0) return resolved
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

/**
 * Fetch a URL through curl, with the request configuration on stdin.
 *
 * The config goes on stdin rather than in argv so that a credential cannot show
 * up in the process list. Shared by the balance and the exchange-rate lookups
 * so there is one place that locates curl and one place that decodes its output.
 *
 * @param ctx - host context carrying the subprocess service.
 * @param options.url - the URL to fetch.
 * @param options.headers - extra request headers.
 * @param options.maxTime - curl's own timeout, in seconds.
 * @returns `{ok, text}` or `{ok: false, reason}`.
 */
async function curlText(ctx, options) {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) return { ok: false, reason: '子进程服务不可用' }

  const curl = await findCurl(subprocess)
  if (curl === null) return { ok: false, reason: '没有找到 curl' }

  const config = ['url = "' + options.url + '"']
  for (const header of options.headers ?? []) config.push('header = "' + header + '"')

  let handle
  try {
    handle = subprocess.spawn({
      // -L because some of these endpoints redirect to their canonical host.
      argv: [curl, '-sSL', '--max-time', String(options.maxTime ?? 20), '--config', '-'],
      // A directory that exists on every platform this client ships for.
      cwd: process.env.USERPROFILE || process.env.HOME || process.cwd(),
      stdio: {
        stdin: { data: config.join('\n') + '\n' },
        stdout: { maxBytes: 1 << 20 },
        stderr: { maxBytes: 8192 },
      },
      graceMs: 5000,
    })
  } catch (error) {
    return { ok: false, reason: '无法启动 curl：' + describeError(error) }
  }

  const outcome = await handle.done
  const stdout = handle.collected?.stdout?.readFrom(0)
  const stderr = handle.collected?.stderr?.readFrom(0)
  const text = typeof stdout?.text === 'string' ? stdout.text : ''
  const errorText = typeof stderr?.text === 'string' ? stderr.text.trim() : ''

  if (outcome.exitCode !== 0) {
    const detail = errorText ? '：' + errorText.slice(0, 200) : ''
    return { ok: false, reason: `请求失败（curl 退出码 ${String(outcome.exitCode)}）${detail}` }
  }
  return { ok: true, text }
}

// ---------------------------------------------------------------------------
// the exchange rate
// ---------------------------------------------------------------------------

/** The resolved rate and its provenance, cached in memory. */
let rateState = null

/** The in-flight rate refresh, so concurrent requests share one lookup. */
let rateInflight = null

/**
 * Fetch a rate from the first source that answers with a plausible one.
 * @param ctx - host context carrying the subprocess service.
 * @returns `{rate, asOf, source}` or null when every source failed.
 */
async function fetchRate(ctx) {
  for (const source of RATE_SOURCES) {
    const response = await curlText(ctx, { url: source.url })
    if (response.ok !== true) continue
    const parsed = parseRate(source, response.text)
    if (parsed === null) continue
    return { rate: parsed.rate, asOf: parsed.asOf, source: source.name }
  }
  return null
}

/**
 * Bring the exchange rate up to date, at most once a day.
 *
 * The lookup is lazy rather than scheduled: the panel is the only thing that
 * reads it, and a plugin that wakes up to make a network call nobody asked for
 * is a worse citizen than one that refreshes on the request that needs it.
 *
 * @param ctx - host context.
 * @param force - ignore the cache and the TTL.
 * @returns `{value, source, fetchedAt, isFallback}`.
 */
function ensureRate(ctx, force) {
  if (rateInflight !== null) return rateInflight

  const now = Date.now()
  if (force !== true && isRateFresh(rateState, now)) {
    return Promise.resolve(describeRate(rateState))
  }

  const run = (async () => {
    const file = ratePath()
    // A previous run's rate is the fallback of last resort: better a day-old
    // rate than the constant this feature exists to replace.
    const cached = rateState ?? await readRateCache(file)
    if (force !== true && isRateFresh(cached, Date.now())) {
      rateState = cached
      return describeRate(cached)
    }

    const fetched = await fetchRate(ctx)
    if (fetched === null) {
      rateState = cached
      return describeRate(cached)
    }

    const entry = {
      rate: fetched.rate,
      fetchedAt: Date.now(),
      source: fetched.source,
      // Kept for the UI, which may show it as "as published on …".
      asOf: fetched.asOf,
    }
    rateState = entry
    try {
      await writeRateCache(file, entry)
    } catch {
      // An unwritable state directory costs durability, not correctness.
    }
    return describeRate(entry)
  })().finally(() => {
    rateInflight = null
  })

  rateInflight = run
  return run
}

// ---------------------------------------------------------------------------
// account balance
// ---------------------------------------------------------------------------

/**
 * Read the account balance through the credentialed DeepSeek endpoint.
 *
 * The key travels on curl's stdin, never in argv, so it cannot show up in the
 * process list.
 * @param ctx - host context carrying credentials and the subprocess service.
 */
async function fetchBalance(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return { available: false, reason: '凭据服务不可用' }

  let key
  try {
    const resolved = await credentials.resolve('DEEPSEEK_API_KEY')
    key = resolved?.value
  } catch (error) {
    return { available: false, reason: '读取 DEEPSEEK_API_KEY 失败：' + describeError(error) }
  }
  if (typeof key !== 'string' || key.length === 0) {
    return { available: false, reason: '未配置 DEEPSEEK_API_KEY' }
  }

  const response = await curlText(ctx, {
    url: 'https://api.deepseek.com/user/balance',
    headers: ['Authorization: Bearer ' + key],
  })
  if (response.ok !== true) return { available: false, reason: response.reason }

  const text = response.text

  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return { available: false, reason: '余额接口返回了非 JSON 内容：' + text.slice(0, 200) }
  }

  const currencies = []
  for (const info of (Array.isArray(payload.balance_infos) ? payload.balance_infos : []).slice(0, 4)) {
    currencies.push({
      currency: typeof info.currency === 'string' ? info.currency : '',
      total: numberOr(Number(info.total_balance), null),
      granted: numberOr(Number(info.granted_balance), null),
      toppedUp: numberOr(Number(info.topped_up_balance), null),
    })
  }
  return { available: true, isAvailable: payload.is_available === true, currencies }
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

/**
 * Mount the report endpoint and warm the index.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  let balanceCache = null

  async function readBalance(force) {
    const now = Date.now()
    if (force !== true && balanceCache !== null && now - balanceCache.at < BALANCE_TTL_MS) {
      return balanceCache.value
    }
    const value = await fetchBalance(ctx)
    balanceCache = { at: now, value }
    return value
  }

  // Build the index now rather than on first open: the panel is opened long
  // after boot, and a warm index is the difference between instant and a
  // several-second stare at "统计中".
  ensureIndex(false).catch(() => {
    // A failed warm-up is not fatal; the request path retries.
  })

  // Same for the exchange rate, which is a network call and is cached for a
  // day — warming it means the first panel open does not wait on it.
  ensureRate(ctx, false).catch(() => {
    // Offline is expected sometimes; the request path retries and the panel
    // falls back to the last known rate.
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      if ((req.method ?? 'GET') !== 'GET') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'method not allowed' }))
        return
      }

      let window = null
      let force = false
      try {
        const params = new URL(req.url ?? ROUTE, 'http://127.0.0.1').searchParams
        window = readWindow(params)
        force = params.get('force') === '1'
      } catch {
        // A malformed query string falls back to the defaults.
      }
      if (window === null) window = trailingWindow(DEFAULT_DAYS)

      try {
        const built = await ensureIndex(force)
        // Resolved before shaping, because the price book converts its CNY
        // quotes with it: a row's cost depends on the rate, not just its label.
        const exchange = await ensureRate(ctx, force)
        const usage = shapeReport(built.index, built.stats, window, exchange)
        const balance = await readBalance(force)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify({ at: Date.now(), balance, usage }))
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({
          balance: { available: false, reason: describeError(error) },
          usage: { available: false, reason: describeError(error) },
        }))
      }
    },
  }), 'dshx-token-cost-route')
}
