// dshx-token-cost — the USD → CNY exchange rate.
//
// The price book is denominated in USD, so every yuan figure in the panel is a
// conversion. That rate used to be a constant, which is fine for a first draft
// and wrong for a number the reader is meant to act on: the constant was 7.1
// while the market rate was 6.71, so every yuan figure was about 6% high.
//
// The rate is now refreshed from a public endpoint at most once a day and
// cached on disk. Caching matters in both directions — a restart reuses what
// was fetched instead of asking again, and a machine that is offline keeps the
// last known rate rather than quietly reverting to a stale constant.
//
// This file is data and parsing only. `index.js` owns the network call, since
// it is the half that has the subprocess service.

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { USD_TO_CNY } from './pricing.js'
import { stateDir } from './usage.js'

/** How long a fetched rate is trusted before it is looked up again. */
export const RATE_TTL_MS = 24 * 60 * 60 * 1000

/** The rate used when nothing has ever been fetched. */
export const FALLBACK_RATE = USD_TO_CNY

/**
 * Whether a rate is believable enough to show.
 *
 * Guards against an endpoint returning a placeholder, a different base
 * currency, or an error page parsed as JSON. A USD→CNY rate outside this band
 * is a broken response rather than a market move, and showing it would misprice
 * every row in the panel — worse than showing nothing.
 */
export function plausibleRate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 2 && value <= 20
}

function numberOrNull(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * The endpoints to try, in order.
 *
 * Two providers rather than two mirrors of one: `er-api` republishes
 * exchangerate-api.com's feed, while `frankfurter` republishes the European
 * Central Bank's reference rates. Agreement between them means something;
 * agreement between two mirrors of the same feed would not.
 */
export const RATE_SOURCES = [
  {
    name: 'er-api',
    url: 'https://open.er-api.com/v6/latest/USD',
    pick(payload) {
      const rate = numberOrNull(payload?.rates?.CNY)
      if (rate === null) return null
      const seconds = numberOrNull(payload?.time_last_update_unix)
      return { rate, asOf: seconds === null ? null : seconds * 1000 }
    },
  },
  {
    name: 'frankfurter',
    url: 'https://api.frankfurter.app/latest?from=USD&to=CNY',
    pick(payload) {
      const rate = numberOrNull(payload?.rates?.CNY)
      return rate === null ? null : { rate, asOf: null }
    },
  },
]

/**
 * Read a source's response.
 * @param source an entry from {@link RATE_SOURCES}.
 * @param text the raw response body.
 * @returns `{rate, asOf}` when the body carries a plausible rate, else null.
 */
export function parseRate(source, text) {
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  let picked
  try {
    picked = source.pick(payload)
  } catch {
    // A source's `pick` reaching into an unexpected shape is a miss, not a crash.
    return null
  }
  if (picked === null || !plausibleRate(picked.rate)) return null
  return { rate: picked.rate, asOf: picked.asOf }
}

/** Absolute path of the rate cache. */
export function ratePath() {
  return path.join(stateDir(), 'rate.json')
}

/**
 * Read the cached rate.
 * @returns `{rate, fetchedAt, source}` or null when there is nothing usable.
 */
export async function readRateCache(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    if (!plausibleRate(parsed.rate)) return null
    if (!Number.isFinite(parsed.fetchedAt)) return null
    return {
      rate: parsed.rate,
      fetchedAt: parsed.fetchedAt,
      source: typeof parsed.source === 'string' ? parsed.source : 'unknown',
    }
  } catch {
    return null
  }
}

/**
 * Persist the rate.
 *
 * Written to a sibling temp file and renamed, so a crash mid-write leaves the
 * previous rate intact rather than a truncated file that reads as no cache.
 */
export async function writeRateCache(file, entry) {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const temp = file + '.tmp'
  await fs.writeFile(temp, JSON.stringify(entry), 'utf8')
  await fs.rename(temp, file)
}

/** Whether a cached rate is still inside its refresh window. */
export function isRateFresh(entry, nowMs) {
  return entry !== null && Number.isFinite(entry.fetchedAt) && nowMs - entry.fetchedAt < RATE_TTL_MS
}

/**
 * The rate to report, and where it came from.
 * @param entry a cache entry, or null.
 * @returns `{value, source, fetchedAt, isFallback}`.
 */
export function describeRate(entry) {
  if (entry === null) {
    return { value: FALLBACK_RATE, source: 'fallback', fetchedAt: null, isFallback: true }
  }
  return { value: entry.rate, source: entry.source, fetchedAt: entry.fetchedAt, isFallback: false }
}
