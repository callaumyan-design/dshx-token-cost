// dshx-token-cost — session-log reader and persistent index.
//
// ## Why this file reads ~/.dsh/sessions directly
//
// The harness exposes a `sessionQuery` service, and asking it is the obvious
// way to count tokens — the first version of this plugin did exactly that, and
// the numbers were right. The problem was time: every `readSession` and
// `filterEvents` call replays and validates a whole session log and builds
// search documents for it, which measured roughly 0.2 s per session. Across
// ~250 sessions that is 50–90 seconds before a single number can be drawn, so
// the settings page sat on "读取中" and looked broken.
//
// Decompressing the same logs directly takes ~5 s for the entire corpus, and a
// persistent index makes every refresh after the first one nearly free. That
// is the trade this file makes: it depends on the on-disk layout — which
// `dshx-session-delete` already does — in exchange for being usable at all.
//
// ## The index
//
// A session log is append-only, so its `(size, mtimeMs)` pair changes only
// when new events land. The index therefore stores, per session, the folded
// per-day/per-model totals plus the size and mtime they were folded from. On
// refresh, a session whose size and mtime still match is reused without being
// opened; only new or growing logs are decoded. In steady state a refresh
// touches one file (the live session) and costs a few milliseconds.
//
// ## Two traps in the on-disk layout
//
// Both were found by comparing the scan against `find` and wondering why 98
// sessions were missing.
//
// * Session directories are named either `<uuid>` or `session-<uuid>`. Both
//   shapes are live at once, so matching only the bare uuid silently drops
//   every `session-` prefixed one.
// * A session directory may hold several log revisions at once —
//   `session.jsonl.zstd`, `session.v3.jsonl.zstd`, `session.v4.jsonl.zstd` —
//   because the harness rewrites the log when it migrates format. The older
//   files are not byte-prefixes of the newer one: `seq` is renumbered and the
//   header gains fields, so the same event appears with a different `seq` and
//   a different serialisation. Folding every file would double count; folding
//   the wrong one would under count. Across this machine's corpus every older
//   revision was verified to be a strict semantic subset of the newest one
//   (matched on `time` + `turn` + `step` + usage), so the newest revision is
//   the only one that needs reading.

import { promises as fs } from 'node:fs'
import zlib from 'node:zlib'
import os from 'node:os'
import path from 'node:path'

import { bucketKey, rowKey } from './pricing.js'

/** zstd frame magic, little-endian. One log file is many frames back to back. */
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Session ids are uuids, and the log directory is named after one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Some directories prefix the uuid; the prefix carries no meaning. */
const SESSION_PREFIX = /^session-/

/**
 * Log revisions are `session.jsonl.zstd` (the oldest, unversioned form) and
 * `session.v<N>.jsonl.zstd`. The unversioned form is revision 0.
 */
const LOG_REVISION = /^session(?:\.v(\d+))?\.jsonl\.zstd$/

/**
 * Bumped whenever the on-disk index shape or the set of indexed sessions
 * changes, so an index written by an older build is discarded instead of being
 * misread. v3 is the first version that sees `session-` prefixed directories.
 * v4 adds the per-hour buckets (`hours`) behind the hourly chart.
 */
export const INDEX_VERSION = 4

/** One local day, for bucketing. */
export const DAY_MS = 86400000

/** The oldest day the index keeps, so it cannot grow without bound. */
export const INDEX_KEEP_DAYS = 400

/**
 * The harness reads DSH_HOME first and falls back to ~/.dsh.
 * @returns the resolved dsh home directory.
 */
export function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.length > 0) return configured
  return path.join(os.homedir(), '.dsh')
}

/**
 * Where this plugin keeps its own state, next to the other dshx plugins'.
 *
 * `DSHX_TOKEN_COST_STATE` overrides it. That exists for the tests, which need a
 * state directory of their own: without it a test run would write its canned
 * exchange rate into the real cache and the panel would report a made-up rate
 * until the next refresh.
 */
export function stateDir() {
  const override = process.env.DSHX_TOKEN_COST_STATE
  if (typeof override === 'string' && override.length > 0) return override
  return path.join(dshHome(), 'dshx-token-cost')
}

export function describeError(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string') return error.message
  return String(error)
}

/** Local calendar day key, `YYYY-MM-DD`, in the machine's own timezone. */
export function dayKey(ms) {
  const d = new Date(ms)
  const pad = (n) => (n < 10 ? '0' + String(n) : String(n))
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/** Local midnight of the day `key` names, as epoch ms. */
export function dayStart(key) {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

/**
 * Whether `value` is a day key this plugin produced.
 *
 * The round-trip through `Date` matters: it rejects `2026-02-30` and friends,
 * which `Date` would otherwise roll over to a neighbouring day and accept.
 */
export function isDayKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  return dayKey(dayStart(value)) === value
}

/**
 * The day key before `key`.
 *
 * Stepping by a fixed {@link DAY_MS} would be wrong twice a year: across a DST
 * change, one local midnight plus 24 hours is not the next local midnight, so
 * the walk skips or repeats a day. `setDate` works on the calendar instead.
 */
export function previousDay(key) {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() - 1)
  return dayKey(date.getTime())
}

/**
 * Day keys from `toDay` back to `fromDay`, newest first.
 *
 * @param limit - the most keys to return, so a range wider than the report
 *   allows is cut down instead of producing an enormous response.
 * @returns {keys, truncated} — `truncated` says whether `limit` bit.
 */
export function daysBetween(fromDay, toDay, limit) {
  const keys = []
  let truncated = false
  let key = toDay
  while (key >= fromDay) {
    if (keys.length >= limit) {
      truncated = true
      break
    }
    keys.push(key)
    key = previousDay(key)
  }
  return { keys, truncated }
}

/** Local midnight, `days - 1` days ago, as epoch ms. */
export function windowStart(days) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime() - (days - 1) * DAY_MS
}

/** Local midnight today, as epoch ms. */
export function todayStart() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** A fresh token bucket. */
export function emptyBucket(label) {
  return {
    label,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    calls: 0,
    routes: [],
  }
}

/**
 * Total tokens in a bucket.
 *
 * This mirrors the harness's own `tokenTotal`: the four provider buckets are
 * disjoint, so all four are summed. They really are disjoint — a real call
 * here reported `inputTokens: 2` against `cacheReadTokens: 71000`, i.e. the
 * field counts only the prompt tokens that missed the cache. Reasoning tokens
 * are deliberately excluded because they are a subset of output tokens, which
 * is why adding them would overstate every total.
 */
export function totalOf(b) {
  return b.input + b.output + b.cacheRead + b.cacheWrite
}

// ---------------------------------------------------------------------------
// reading the corpus
// ---------------------------------------------------------------------------

/**
 * Decode a session log.
 *
 * The file is a concatenation of independent zstd frames, not one stream, so
 * the frames are located by their magic bytes and inflated one at a time. A
 * torn final frame is normal for a log being written right now, so a frame
 * that fails to inflate is skipped rather than failing the whole file.
 *
 * @param buffer - the raw file contents.
 * @returns the concatenated decompressed text.
 */
export function decodeLog(buffer) {
  const parts = []
  let i = 0
  for (;;) {
    const start = buffer.indexOf(FRAME_MAGIC, i)
    if (start < 0) break
    let end = buffer.indexOf(FRAME_MAGIC, start + 4)
    if (end < 0) end = buffer.length
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(start, end)))
    } catch {
      // A partially written frame simply contributes nothing.
    }
    i = end
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * Pull the provider/model pair out of a `request/header` or `request/context`
 * event, whichever shape it arrives in.
 * @param event a session event.
 * @returns the pair, or null when the event does not name one.
 */
function modelOf(event) {
  const data = event?.data
  if (!data) return null
  const config = data.header?.config
  const provider = data.provider ?? config?.provider
  const model = data.model ?? config?.model
  if (typeof provider !== 'string' || provider.length === 0) return null
  return { provider, model: typeof model === 'string' && model.length > 0 ? model : provider }
}

/**
 * Fold one decoded session log into `days × models` buckets.
 *
 * Events are read in the order the log stored them, which is the order they
 * happened, so a `request/header` always precedes the messages it governs.
 * That pairing is the whole trick: without it the log knows how many tokens
 * were spent but not which model spent them.
 *
 * @param text - decoded log text.
 * @param into - accumulator: Map<dayKey, Map<label, bucket>>.
 * @param hoursInto - optional accumulator for the hourly chart:
 *   Map<dayKey, Map<hour 0–23, Map<label, bucket>>>. The hour is the local
 *   clock hour of the message, so it lines up with the day key.
 * @returns counts of attributed and header-less messages, for diagnostics.
 */
export function foldSessionText(text, into, hoursInto) {
  let current = null
  let attributed = 0
  let orphan = 0

  for (const line of text.split('\n')) {
    if (!line) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      // A truncated final line is normal; skip it.
      continue
    }

    if (event.type === 'request/header' || event.type === 'request/context') {
      const found = modelOf(event)
      if (found !== null) current = found
      continue
    }

    if (event.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (!usage) continue

    const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : 0
    const owner = current ?? { provider: 'unknown', model: 'unknown' }
    if (current === null) orphan += 1
    else attributed += 1

    // Group by vendor model rather than by gateway: the same model reached
    // through two pipes is one line of spend, not two.
    const label = bucketKey(owner.provider, owner.model)
    const route = rowKey(owner.provider, owner.model)
    const day = dayKey(time)

    let byDay = into.get(day)
    if (byDay === undefined) {
      byDay = new Map()
      into.set(day, byDay)
    }
    let bucket = byDay.get(label)
    if (bucket === undefined) {
      bucket = emptyBucket(label)
      byDay.set(label, bucket)
    }
    addUsage(bucket, route, usage)

    if (hoursInto !== undefined && hoursInto !== null) {
      const hour = new Date(time).getHours()
      let hoursOfDay = hoursInto.get(day)
      if (hoursOfDay === undefined) {
        hoursOfDay = new Map()
        hoursInto.set(day, hoursOfDay)
      }
      let byLabel = hoursOfDay.get(hour)
      if (byLabel === undefined) {
        byLabel = new Map()
        hoursOfDay.set(hour, byLabel)
      }
      let hourBucket = byLabel.get(label)
      if (hourBucket === undefined) {
        hourBucket = emptyBucket(label)
        byLabel.set(label, hourBucket)
      }
      addUsage(hourBucket, route, usage)
    }
  }

  return { attributed, orphan }
}

/** Add one message's usage to a bucket. */
function addUsage(bucket, route, usage) {
  if (!bucket.routes.includes(route)) bucket.routes.push(route)
  bucket.input += numberOr(usage.inputTokens)
  bucket.output += numberOr(usage.outputTokens)
  bucket.cacheRead += numberOr(usage.cacheReadTokens)
  bucket.cacheWrite += numberOr(usage.cacheWriteTokens)
  bucket.reasoning += numberOr(usage.reasoningTokens)
  bucket.calls += 1
}

function numberOr(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Find the newest log of every session under `<home>/sessions`.
 *
 * The layout is `sessions/<bucket>/<session>/session[.v<N>].jsonl.zstd`. The
 * bucket name encodes the workspace path and is not derivable without
 * duplicating the harness's own key derivation, so the tree is walked instead.
 *
 * A session directory may hold several revisions; only the highest is
 * returned, for the reason given in the file header. Session ids are
 * normalised to a bare lowercase uuid so that `<uuid>` and `session-<uuid>`
 * cannot produce two entries for one session.
 *
 * @param home - resolved dsh home directory.
 * @returns Map<sessionId, {path, size, mtimeMs, revision}>.
 */
export async function scanSessionFiles(home) {
  const found = new Map()
  const root = path.join(home, 'sessions')

  let buckets
  try {
    buckets = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return found
  }

  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    const bucketDir = path.join(root, bucket.name)
    let sessions
    try {
      sessions = await fs.readdir(bucketDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const id = session.name.replace(SESSION_PREFIX, '').toLowerCase()
      if (!UUID.test(id)) continue

      const sessionDir = path.join(bucketDir, session.name)
      let files
      try {
        files = await fs.readdir(sessionDir)
      } catch {
        continue
      }

      let best = null
      for (const file of files) {
        const match = LOG_REVISION.exec(file)
        if (match === null) continue
        const revision = match[1] === undefined ? 0 : Number(match[1])
        if (best === null || revision > best.revision) {
          best = { file, revision }
        }
      }
      if (best === null) continue

      const full = path.join(sessionDir, best.file)
      try {
        const stat = await fs.stat(full)
        const entry = {
          path: full,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          revision: best.revision,
        }
        // A uuid belongs to exactly one workspace bucket, so a collision means
        // something unexpected; keeping the newer log is the safe resolution.
        const previous = found.get(id)
        if (previous === undefined || entry.mtimeMs > previous.mtimeMs) {
          found.set(id, entry)
        }
      } catch {
        // A log that vanished mid-scan simply is not indexed.
      }
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// the persistent index
// ---------------------------------------------------------------------------

/** Absolute path of the index file. */
export function indexPath() {
  return path.join(stateDir(), 'index.json')
}

/**
 * Read the index, or return an empty one.
 *
 * A missing, unreadable, or wrong-version index is not an error: it just means
 * the next build starts from scratch.
 * @returns {version, builtAt, sessions: {}} shaped index.
 */
export async function readIndex(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    if (parsed?.version !== INDEX_VERSION) return emptyIndex()
    if (parsed.sessions === null || typeof parsed.sessions !== 'object') return emptyIndex()
    return parsed
  } catch {
    return emptyIndex()
  }
}

export function emptyIndex() {
  return { version: INDEX_VERSION, builtAt: 0, sessions: {} }
}

/**
 * Persist the index.
 *
 * Written to a sibling temp file and renamed, so a crash mid-write leaves the
 * previous index intact rather than a half-written one.
 * @param file - destination path.
 * @param index - the index to store.
 */
export async function writeIndex(file, index) {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const temp = file + '.tmp'
  await fs.writeFile(temp, JSON.stringify(index), 'utf8')
  await fs.rename(temp, file)
}

/**
 * Drop days older than the retention window, and sessions that no longer have
 * a log, so the index stays bounded as history accumulates.
 *
 * @param index - the index to prune in place.
 * @param keepDays - how many days of history to retain.
 * @param nowMs - current time, injected so the pruning is testable.
 * @returns the number of sessions dropped.
 */
export function pruneIndex(index, keepDays, nowMs) {
  const oldest = dayKey(nowMs - keepDays * DAY_MS)
  let dropped = 0
  for (const [id, entry] of Object.entries(index.sessions)) {
    const days = entry?.days
    if (days === null || typeof days !== 'object') {
      delete index.sessions[id]
      dropped += 1
      continue
    }
    for (const key of Object.keys(days)) {
      if (key < oldest) delete days[key]
    }
    const hours = entry.hours
    if (hours !== null && typeof hours === 'object') {
      for (const key of Object.keys(hours)) {
        if (key < oldest) delete hours[key]
      }
    }
  }
  return dropped
}

/** Serialise a Map<dayKey, Map<hour, Map<label, bucket>>> into plain JSON. */
export function serializeHours(byDay) {
  const out = {}
  for (const [day, hours] of byDay) {
    const row = {}
    for (const [hour, buckets] of hours) {
      const cell = {}
      for (const [label, bucket] of buckets) cell[label] = bucket
      row[String(hour)] = cell
    }
    out[day] = row
  }
  return out
}

/** Serialise a Map<dayKey, Map<label, bucket>> into plain JSON. */
export function serializeDays(byDay) {
  const out = {}
  for (const [day, buckets] of byDay) {
    const row = {}
    for (const [label, bucket] of buckets) row[label] = bucket
    out[day] = row
  }
  return out
}
