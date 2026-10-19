#!/usr/bin/env node
// dshx-token-cost — client half test.
//
// Loads `client.js` the way the harness does — through
// `window.__ModuleLoader__.load` — then really mounts the registered Settings
// page in jsdom and asserts on the markup it produces. That catches the class
// of bug a host-only test cannot: a render that throws, leaving the settings
// page blank, or a field the panel reads that the endpoint no longer sends.
//
// The payload fed to the page is not hand-written; it is produced by the real
// host half through the real route, so host and client are checked against each
// other rather than against a fixture that could drift.
//
// Requires react, react-dom and jsdom. Install them anywhere and point NODE_PATH
// (or DSHX_TEST_NODE_MODULES) at that node_modules. It says so if they are missing.
//
// Run:  node test-client.mjs

import { promises as fs, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

import { apply as hostApply } from './index.js'

/**
 * Keep the plugin's state out of the real one, and clean up after the run.
 *
 * The host caches the exchange rate on disk, and this test stubs the network
 * out, so without this the panel's rate would be written into the real profile.
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

const WORKSPACE = process.env.DSHX_TEST_NODE_MODULES ?? process.env.NODE_PATH ?? '<your node_modules>'
const require = createRequire(import.meta.url)

function need(name) {
  try {
    return require(name)
  } catch (error) {
    console.error(`missing dependency "${name}".`)
    console.error('Install it, then re-run:')
    console.error('  npm install --no-save react@18 react-dom@18 jsdom')
    console.error('Or run with NODE_PATH=' + WORKSPACE)
    throw error
  }
}

const React = need('react')
const { createRoot } = need('react-dom/client')
const { JSDOM } = need('jsdom')
const { act } = React

// ---- jsdom ----------------------------------------------------------------

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:19387/',
})
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = true
// Node defines `navigator` as a getter-only global, so it needs redefining
// rather than assigning.
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
})

// ---- load the client module the way the harness does ----------------------

const source = await fs.readFile(new URL('./client.js', import.meta.url), 'utf8')

let definition = null
dom.window.__ModuleLoader__ = { load(def) { definition = def } }

// The module is a plain script that calls into `window.__ModuleLoader__`; it is
// not an ES module, so it is evaluated with `window` bound rather than imported.
// It is bound to the real jsdom window rather than a bare object so that the
// globals the panel touches — `localStorage` in particular — are the real ones.
new Function('window', source)(dom.window)

if (definition === null) throw new Error('client.js did not call __ModuleLoader__.load')
console.log(`module id     ${definition.id}`)

const clientRequire = (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}
const client = definition.factory(clientRequire)

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures += 1
  console.log(`  [${mark}] ${label}${detail === undefined ? '' : '  ' + detail}`)
}

console.log(`injects       ${JSON.stringify(client.inject)}`)
check('injects only the slots service',
  Array.isArray(client.inject) && client.inject.length === 1 && client.inject[0] === 'slots')
check('exports apply', typeof client.apply === 'function')

// ---- register the page ----------------------------------------------------

let registration = null
const clientCtx = {
  slots: {
    inject(name, fn) {
      if (name !== 'settings.section') throw new Error('unexpected slot: ' + name)
      return fn()
    },
    register(meta, component) {
      registration = { meta, component }
      return () => { registration = null }
    },
  },
}
client.apply(clientCtx)

check('registered a settings section',
  registration !== null && registration.meta.name === 'settings.section')
check('section is labelled 用量与费用',
  registration?.meta?.label === '用量与费用', registration?.meta?.label)
check('section has a stable id', registration?.meta?.id === 'dshx-token-cost')

// ---- a real payload from the real host half ------------------------------

/**
 * The wallets the stubbed balance endpoint reports.
 *
 * Real shape: the platform returns one entry per currency wallet and does not
 * order them stably — three live calls came back USD/CNY, CNY/USD, USD/CNY.
 * The default here is deliberately the order that used to break the card, so a
 * `currencies[0]` regression shows up rather than passing by luck.
 */
let wallets = [
  { currency: 'USD', total_balance: '21.08', granted_balance: '0.00', topped_up_balance: '21.08' },
  { currency: 'CNY', total_balance: '88.40', granted_balance: '0.00', topped_up_balance: '88.40' },
]

const credentials = {
  async resolve(key) {
    if (key !== 'DEEPSEEK_API_KEY') throw new Error('unexpected credential: ' + key)
    return { value: 'sk-test-not-a-real-key' }
  },
}
const subprocess = {
  async resolveExecutable(name) { return name === 'curl' || name === 'curl.exe' ? 'curl' : null },
  spawn(options) {
    // Routed on the URL the real call puts in curl's stdin config.
    const config = options?.stdio?.stdin?.data ?? ''
    const match = /url = "([^"]+)"/.exec(config)
    const url = match === null ? '' : match[1]
    let text = '{}'
    if (url.includes('deepseek.com')) {
      text = JSON.stringify({ is_available: true, balance_infos: wallets })
    } else if (url.includes('open.er-api.com')) {
      text = JSON.stringify({ result: 'success', time_last_update_unix: 1791676951, rates: { CNY: 6.706851 } })
    } else if (url.includes('frankfurter')) {
      text = JSON.stringify({ rates: { CNY: 6.6921 } })
    }
    return {
      done: Promise.resolve({ exitCode: 0 }),
      collected: {
        stdout: { readFrom: () => ({ text }) },
        stderr: { readFrom: () => ({ text: '' }) },
      },
    }
  },
}

let hostRoute = null
const services = {
  credentials,
  subprocess,
  webServer: { register(route) { hostRoute = route; return () => { hostRoute = null } } },
}
hostApply({
  get: (key) => services[key],
  effect: (fn) => fn(),
  webServer: services.webServer,
})

function callHostRoute(url) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const res = {
      writeHead() { /* status is not asserted here */ },
      end(body) {
        if (body !== undefined) chunks.push(Buffer.from(String(body)))
        resolve(Buffer.concat(chunks).toString('utf8'))
      },
      on() { /* unused */ },
    }
    Promise.resolve(hostRoute.handler({ method: 'GET', url }, res)).catch(reject)
  })
}

const payloadText = await callHostRoute('/dshx-token-cost/report?days=30')
const payload = JSON.parse(payloadText)
console.log(`payload       usage ${payload.usage.models.length} models, `
  + `${payload.usage.days.length} days, balance ${payload.balance.available ? 'ok' : 'n/a'}`)

/** The newest day, which is the first row of the daily table. */
const newest = payload.usage.days[0]
const rate = payload.usage.meta.usdToCny

/** The panel's compact token format, so assertions can predict a cell's text. */
function compact(value) {
  if (value >= 1e9) return (value / 1e9).toFixed(2) + 'B'
  if (value >= 1e6) return (value / 1e6).toFixed(2) + 'M'
  if (value >= 1e4) return (value / 1e3).toFixed(1) + 'K'
  return String(value)
}

/**
 * How a day's cost should be rendered in a given display currency.
 *
 * Mirrors the panel's rule of dropping cents at four figures, so the assertion
 * is about the currency rather than about a hard-coded string.
 */
function costText(usd, currency, rate) {
  const value = currency === 'CNY' ? usd * rate : usd
  const places = Math.abs(value) >= 1000 ? 0 : 2
  return (currency === 'CNY' ? '¥' : '$') + value.toFixed(places)
}

/** Inclusive day count between two `YYYY-MM-DD` keys. */
function countDays(from, to) {
  const pad = (n) => (n < 10 ? '0' + String(n) : String(n))
  let count = 0
  let cursor = from
  while (cursor <= to && count <= 400) {
    count += 1
    const [y, m, d] = cursor.split('-').map(Number)
    const date = new Date(y, m - 1, d)
    date.setDate(date.getDate() + 1)
    cursor = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
  }
  return count
}

/**
 * The headline balance figure, isolated from the secondary wallet line.
 *
 * Every wallet is somewhere in the markup — the secondary one is listed under
 * the headline — so asserting against the whole page cannot tell which wallet
 * is being headlined, which is the thing that used to flip.
 */
function balanceHeadline(html) {
  // jsdom re-serialises the style attribute through the CSSOM, which inserts a
  // space after each colon, so the match must tolerate `font-size: 30px`.
  const match = /font-size:\s*30px[^>]*>([^<]*)</.exec(html)
  return match === null ? null : match[1]
}

// ---- mount the page -------------------------------------------------------

// Each scenario gets a fresh root on a fresh container. Re-rendering the same
// instance would not re-run the effect, because its `[days, request]` deps
// would be unchanged, so a new fetch behaviour would never be picked up.

let currentRoot = null
let currentHost = null

/**
 * Mount the page with a given fetch behaviour and return the resulting markup.
 * @param impl - the fetch implementation to install.
 */
async function render(impl) {
  if (currentRoot !== null) {
    const previous = currentRoot
    const previousHost = currentHost
    await act(async () => { previous.unmount() })
    previousHost.remove()
  }

  currentHost = document.createElement('div')
  document.body.appendChild(currentHost)
  currentRoot = createRoot(currentHost)
  globalThis.fetch = impl

  await act(async () => {
    currentRoot.render(React.createElement(registration.component))
  })
  // The effect's promise chain is several ticks deep (fetch → json → setState),
  // so give it a macrotask to settle before reading the markup.
  await act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
  return currentHost.innerHTML
}

console.log('\n--- loading state ---')
// A fetch that never settles keeps the component in its loading phase.
const pending = await render(() => new Promise(() => {}))
check('renders the page title', pending.includes('用量与费用'))
check('renders the balance placeholder', pending.includes('账户余额'))
check('shows a loading hint rather than a blank page',
  pending.includes('正在统计') || pending.includes('读取中'))
check('disables the refresh button while loading', pending.includes('统计中'))

console.log('\n--- loaded state (real payload) ---')
let seenUrl = null
/**
 * The happy-path fetch, reused by every later scenario.
 *
 * It echoes the requested window back the way the host does — `mode`,
 * `fromDay`, `toDay`, `windowDays` — rather than returning one fixed fixture.
 * Without that the panel's range display could never be exercised, because
 * every response would claim to be the initial trailing window.
 */
const okFetch = (url) => {
  seenUrl = url
  const params = new URLSearchParams(String(url).split('?')[1] ?? '')
  const from = params.get('from')
  const to = params.get('to')
  const days = Number(params.get('days'))
  const usage = Object.assign({}, payload.usage)
  if (from !== null && to !== null) {
    const [low, high] = from <= to ? [from, to] : [to, from]
    usage.mode = 'custom'
    usage.fromDay = low
    usage.toDay = high
    usage.windowDays = countDays(low, high)
  } else {
    usage.mode = 'trailing'
    usage.windowDays = Number.isFinite(days) && days >= 1 ? days : 30
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(Object.assign({}, payload, { usage })),
  })
}
const html = await render(okFetch)

check('requested the report endpoint', String(seenUrl).startsWith('/dshx-token-cost/report'), String(seenUrl))
check('requested the default window', String(seenUrl).includes('days=30'))
check('no longer stuck on the loading line', !html.includes('正在统计'))
check('renders the account balance card', html.includes('账户余额'))
// The platform lists USD first here, which is the order that used to decide the
// headline by accident. With CNY selected the headline must still be the CNY
// wallet.
check('headlines the wallet matching the display currency',
  balanceHeadline(html) === '¥88.40', String(balanceHeadline(html)))
check('does not mislabel the balance as dollars',
  !html.includes('$88.40'), 'must not show $88.40')
check('lists the other wallet as a secondary line',
  html.includes('另有 $21.08'), 'expected 另有 $21.08')
check('renders the availability badge', html.includes('可用'))
check('renders the summary card', html.includes('区间汇总'))
check('renders the estimated cost metric', html.includes('估算费用'))
check('renders the total-token metric', html.includes('合计 token'))
check('renders the cache-hit metric', html.includes('缓存命中率'))
// The daily table folds cache reads and writes into one figure; the per-model
// table is the one that splits them.
check('daily table labels a combined cache column',
  html.includes('缓存读写'), 'expected 缓存读写')
check('only the per-model table splits cache read from write',
  (html.match(/>缓存写</g) ?? []).length === 1,
  (html.match(/>缓存写</g) ?? []).length + ' occurrence(s) of 缓存写')
check('the combined cache cell explains its split',
  /title="读 [\d,]+ · 写 [\d,]+"/.test(html), 'expected a read/write tooltip')
// The daily table's figures have to add up: the combined cache column is what
// makes `输入 + 输出 + 缓存读写` equal `合计`, so a wrong sum would show here.
check('the combined cache figure is the read plus the write',
  html.includes(compact(newest.cacheRead + newest.cacheWrite)),
  compact(newest.cacheRead + newest.cacheWrite))
check('the daily figures add up to the day total',
  newest.input + newest.output + newest.cacheRead + newest.cacheWrite === newest.total,
  `${newest.input} + ${newest.output} + ${newest.cacheRead} + ${newest.cacheWrite} vs ${newest.total}`)
check('renders the daily table', html.includes('每日用量'))
check('renders the per-model table', html.includes('按模型汇总'))
check('renders the price-book footnote', html.includes(payload.usage.meta.pricesAsOf))
// The rate is fetched by the host, so the panel has to show which rate it used
// and where it came from — a yuan figure the reader cannot trace is not usable.
check('shows the exchange rate it converted with',
  html.includes('1 USD = ¥' + payload.usage.meta.usdToCny.toFixed(4)),
  '1 USD = ¥' + payload.usage.meta.usdToCny.toFixed(4))
check('names where the rate came from', html.includes(payload.usage.meta.rateSource),
  payload.usage.meta.rateSource)
check('renders the version footer', html.includes('dshx-token-cost v2.1.0'))
check('renders the hourly chart card', html.includes('按小时用量'))
check('the hourly chart draws an svg with bars',
  /aria-label="按小时的 token 用量与估算费用"/.test(html) && /<rect[^>]+fill="rgba\(88,166,255/.test(html))
check('the hourly chart draws the cost line', /<polyline[^>]+stroke="#d2691e"/.test(html))
check('the hourly chart offers both views', html.includes('时间线') && html.includes('24 小时分布'))
check('the hourly chart names the priciest hour', html.includes('最贵的一小时'))
check('shows the indexed session count',
  html.includes(String(payload.usage.meta.sessionsIndexed)))
check('names at least one real model',
  payload.usage.models.some((m) => html.includes(m.label)),
  payload.usage.models.slice(0, 3).map((m) => m.label).join(', '))
check('warns about no unpriced models',
  payload.usage.meta.unpricedModels.length > 0 || !html.includes('未在价目表中'))

console.log('\n--- window switch ---')
// Clicking a range chip must re-request with the new window. The chips are the
// only buttons whose text is a day count, so the first one is "7 天".
const buttons = [...dom.window.document.querySelectorAll('button')]
const sevenDay = buttons.find((b) => b.textContent.trim() === '7 天')
check('found the 7-day chip', sevenDay !== undefined,
  buttons.map((b) => b.textContent.trim()).join(' | '))
if (sevenDay !== undefined) {
  await act(async () => { sevenDay.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  check('re-requested with days=7', String(seenUrl).includes('days=7'), String(seenUrl))
}

console.log('\n--- balance unavailable ---')
const noBalance = JSON.parse(payloadText)
noBalance.balance = { available: false, reason: '未配置 DEEPSEEK_API_KEY' }
const warn = await render(() => Promise.resolve({
  ok: true, status: 200, json: () => Promise.resolve(noBalance),
}))
check('surfaces the balance failure reason', warn.includes('未配置 DEEPSEEK_API_KEY'))
check('explains how to fix it', warn.includes('DEEPSEEK_API_KEY'))
check('still renders the usage tables', warn.includes('按模型汇总'))

console.log('\n--- request failure ---')
const broken = await render(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }))
check('reports the HTTP failure', broken.includes('读取失败'), 'expected 读取失败')
check('includes the status code', broken.includes('500'))

console.log('\n--- exchange rate fallback ---')
// The host reports a fallback when it has never managed to fetch a rate; the
// panel has to say so rather than quietly presenting the constant as current.
const fallbackPayload = JSON.parse(payloadText)
fallbackPayload.usage.meta = Object.assign({}, fallbackPayload.usage.meta, {
  usdToCny: 7.1,
  rateSource: 'fallback',
  rateFetchedAt: null,
  rateIsFallback: true,
  rateFallback: 7.1,
})
const fallbackHtml = await render(() => Promise.resolve({
  ok: true, status: 200, json: () => Promise.resolve(fallbackPayload),
}))
check('labels the rate as the built-in default',
  fallbackHtml.includes('1 USD = ¥7.1000（内置默认值）'), 'expected the fallback label')
check('warns that the rate could not be fetched',
  fallbackHtml.includes('联网获取失败'), 'expected a warning')
check('still renders the tables', fallbackHtml.includes('按模型汇总'))

console.log('\n--- usage unavailable ---')
const noUsage = JSON.parse(payloadText)
noUsage.usage = { available: false, reason: '统计不可用' }
const usageDown = await render(() => Promise.resolve({
  ok: true, status: 200, json: () => Promise.resolve(noUsage),
}))
check('surfaces the usage failure reason', usageDown.includes('统计不可用'))
check('does not render the daily table', !usageDown.includes('每日用量'))

await act(async () => { currentRoot.unmount() })
currentHost.remove()

// ---- remembered preferences ----------------------------------------------

console.log('\n--- remembered preferences ---')

/** The chips whose text marks them as a range or a currency choice. */
function chips() {
  return [...dom.window.document.querySelectorAll('button')]
    .filter((b) => /(天|人民币|美元)$/.test(b.textContent.trim()))
}

/** Which currency chip is drawn as selected (the active chip is bold). */
function activeCurrency() {
  const found = chips().find((b) => /(人民币|美元)$/.test(b.textContent.trim())
    && b.style.fontWeight === '600')
  return found === undefined ? null : found.textContent.trim()
}

dom.window.localStorage.clear()
const fresh = await render(okFetch)
check('starts on CNY when nothing is stored', activeCurrency() === '¥ 人民币', String(activeCurrency()))
const written = dom.window.localStorage.getItem('dshx-token-cost/prefs')
check('writes a preference record', written !== null, String(written))
check('records the defaults', String(written).includes('"currency":"CNY"'), String(written))
check('renders costs in CNY', fresh.includes(costText(newest.cost, 'CNY', rate)),
  costText(newest.cost, 'CNY', rate))

const usd = chips().find((b) => b.textContent.trim() === '$ 美元')
check('found the USD chip', usd !== undefined, chips().map((b) => b.textContent.trim()).join(' | '))
if (usd !== undefined) {
  await act(async () => { usd.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  check('the USD chip becomes active', activeCurrency() === '$ 美元', String(activeCurrency()))
  check('persists the switch',
    String(dom.window.localStorage.getItem('dshx-token-cost/prefs')).includes('"currency":"USD"'),
    String(dom.window.localStorage.getItem('dshx-token-cost/prefs')))

  // Remounting is what happens every time the settings page is reopened.
  const remounted = await render(okFetch)
  check('reopens on the remembered currency', activeCurrency() === '$ 美元', String(activeCurrency()))
  check('renders costs in the remembered currency',
    remounted.includes(costText(newest.cost, 'USD', rate)),
    costText(newest.cost, 'USD', rate))
  // The balance follows the same choice, so the headline moves to the dollar
  // wallet instead of staying on whichever one the platform listed first.
  check('the balance headline follows the currency too',
    balanceHeadline(remounted) === '$21.08', String(balanceHeadline(remounted)))
  check('and demotes the yuan wallet to the secondary line',
    remounted.includes('另有 ¥88.40'), 'expected 另有 ¥88.40')

  // The platform's ordering is not stable, so the headline must not depend on
  // it. The payload is reversed in place rather than the stub's wallet list,
  // because the host half caches its own balance response for two minutes —
  // asking it again would hand back the original order and the assertion would
  // pass without testing anything.
  payload.balance.currencies.reverse()
  const reversed = await render(okFetch)
  check('wallet order does not change the headline',
    balanceHeadline(reversed) === '$21.08', String(balanceHeadline(reversed)))
  payload.balance.currencies.reverse()
}

// A stored value that is no longer valid must not break the panel.
dom.window.localStorage.setItem('dshx-token-cost/prefs', '{"currency":"XYZ","days":"nonsense"}')
await render(okFetch)
check('ignores an unknown currency', activeCurrency() === '¥ 人民币', String(activeCurrency()))

dom.window.localStorage.setItem('dshx-token-cost/prefs', 'not json at all')
const recovered = await render(okFetch)
check('survives unparseable storage', recovered.includes('区间汇总'))

// ---- range controls ------------------------------------------------------

console.log('\n--- range controls ---')

/** A chip button by its exact label. */
function chipByText(text) {
  return [...dom.window.document.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === text)
}

/** Click a chip and let the request it triggers settle. */
async function clickChip(text) {
  const button = chipByText(text)
  if (button === undefined) throw new Error('no chip labelled ' + text)
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
}

/** The date inputs, present only while a custom range is open. */
function dateFields() {
  return [...dom.window.document.querySelectorAll('input[type="date"]')]
}

/**
 * Calendar arithmetic for the expectations below.
 *
 * The seeded-range and echoed-window assertions used to hard-code
 * `2026-09-12`/`2026-10-11`, which made the suite fail on every day after
 * 2026-10-11 — the panel was right and the test was stale. These compute the
 * same values from the real clock instead, so the checks keep their meaning
 * forever.
 */
function addDays(key, delta) {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + delta)
  const pad = (n) => (n < 10 ? '0' + String(n) : String(n))
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

const NOW = new Date()
const TODAY = (() => {
  const pad = (n) => (n < 10 ? '0' + String(n) : String(n))
  return NOW.getFullYear() + '-' + pad(NOW.getMonth() + 1) + '-' + pad(NOW.getDate())
})()
/** First and last day of the month `NOW` falls in. */
const MONTH_FROM = TODAY.slice(0, 8) + '01'
const MONTH_TO = (() => {
  const pad = (n) => (n < 10 ? '0' + String(n) : String(n))
  const last = new Date(NOW.getFullYear(), NOW.getMonth() + 1, 0)
  return last.getFullYear() + '-' + pad(last.getMonth() + 1) + '-' + pad(last.getDate())
})()
const MONTH_DAYS = countDays(MONTH_FROM, MONTH_TO)

/**
 * Set a controlled input's value the way a user would.
 *
 * React tracks the previous value on the node itself, so assigning `.value`
 * directly makes it think nothing changed and drop the event. Going through the
 * prototype's setter sidesteps the tracker.
 */
async function typeDate(input, value) {
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setter.call(input, value)
    // React listens on both for a date input; dispatching only `input` left the
    // component's state untouched under jsdom, so both go out.
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
}

dom.window.localStorage.clear()
await render(okFetch)

check('offers 当天', chipByText('当天') !== undefined,
  [...dom.window.document.querySelectorAll('button')].map((b) => b.textContent.trim()).join(' | '))
check('offers 当月', chipByText('当月') !== undefined)
check('offers 自定义', chipByText('自定义') !== undefined)
check('no date fields until 自定义 is chosen', dateFields().length === 0)

/** The range chips, in the order they are rendered. */
function rangeChipOrder() {
  const wanted = ['当天', '当月', '7 天', '14 天', '30 天', '90 天', '自定义']
  const all = [...dom.window.document.querySelectorAll('button')]
    .map((b) => b.textContent.trim())
  return all.filter((text) => wanted.includes(text)).join(' | ')
}

// The order is a product decision, not an accident of `unshift` vs `splice`:
// 当月 sits right after 当天, ahead of the trailing "last N days" windows.
check('当月 follows 当天', rangeChipOrder() === '当天 | 当月 | 7 天 | 14 天 | 30 天 | 90 天 | 自定义',
  rangeChipOrder())

// `当月` is the calendar month, not a trailing day count: it must ask for the
// 1st through month-end, and January must still end on the 31st.
await clickChip('当月')
check('当月 asks for the first day of this month',
  String(seenUrl).includes('from=' + MONTH_FROM), String(seenUrl))
check('当月 asks through the last day of this month',
  String(seenUrl).includes('to=' + MONTH_TO), String(seenUrl))
check('当月 stops sending days', !String(seenUrl).includes('days='), String(seenUrl))
check('当月 persists as a month choice, not as frozen dates',
  String(dom.window.localStorage.getItem('dshx-token-cost/prefs')).includes('"kind":"month"'),
  String(dom.window.localStorage.getItem('dshx-token-cost/prefs')))
check('当月 echoes the window it covered',
  currentHost.innerHTML.includes(MONTH_FROM + ' → ' + MONTH_TO
    + '（' + MONTH_DAYS + ' 天）'),
  'expected ' + MONTH_FROM + ' → ' + MONTH_TO)

// A stored month must be recomputed on the next open, not replayed: that is
// what keeps it "this month" rather than "the month I first clicked it".
dom.window.localStorage.setItem('dshx-token-cost/prefs', '{"range":{"kind":"month"}}')
await render(okFetch)
check('a stored 当月 reopens as this month',
  String(seenUrl).includes('from=' + MONTH_FROM) && String(seenUrl).includes('to=' + MONTH_TO),
  String(seenUrl))

await clickChip('当天')
check('当天 asks for a one-day window', String(seenUrl).includes('days=1'), String(seenUrl))
check('当天 persists', String(dom.window.localStorage.getItem('dshx-token-cost/prefs')).includes('"days":1'),
  String(dom.window.localStorage.getItem('dshx-token-cost/prefs')))

await clickChip('30 天')
check('a preset goes back to a trailing window',
  String(seenUrl).includes('days=30'), String(seenUrl))

await clickChip('自定义')
const fields = dateFields()
check('自定义 reveals two date fields', fields.length === 2, String(fields.length))
const seedFrom = addDays(TODAY, -29)
check('自定义 seeds the range from the preset it replaced',
  fields[0].value === seedFrom && fields[1].value === TODAY,
  `${fields[0].value} -> ${fields[1].value}`)
check('the seeded range is requested as from/to',
  String(seenUrl).includes('from=' + seedFrom) && String(seenUrl).includes('to=' + TODAY),
  String(seenUrl))
check('a custom range stops sending days',
  !String(seenUrl).includes('days='), String(seenUrl))

if (fields.length === 2) {
  await typeDate(fields[0], MONTH_FROM)
  check('editing the start re-requests with it',
    String(seenUrl).includes('from=' + MONTH_FROM), String(seenUrl))
  check('the custom range persists',
    String(dom.window.localStorage.getItem('dshx-token-cost/prefs')).includes('"kind":"custom"'),
    String(dom.window.localStorage.getItem('dshx-token-cost/prefs')))
  // The whole status string, not just the date: a bare date would also match a
  // table row's tooltip, which is a different thing entirely.
  check('the panel echoes the effective window',
    currentHost.innerHTML.includes(MONTH_FROM + ' → ' + TODAY
      + '（' + countDays(MONTH_FROM, TODAY) + ' 天）'),
    'expected the range in the status line')

  // A half-filled range must not silently answer a different question.
  const before = seenUrl
  await typeDate(fields[0], '')
  check('clearing a date does not fire a different request', seenUrl === before, String(seenUrl))
}

// The previous build stored a bare `days` number; that choice must survive.
dom.window.localStorage.setItem('dshx-token-cost/prefs', '{"days":14,"currency":"USD"}')
await render(okFetch)
check('migrates an older stored range', String(seenUrl).includes('days=14'), String(seenUrl))
check('and the older stored currency', activeCurrency() === '$ 美元', String(activeCurrency()))

dom.window.localStorage.clear()
await act(async () => { currentRoot.unmount() })
currentHost.remove()

console.log('')
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`)
  process.exitCode = 1
} else {
  console.log('all checks passed')
}
