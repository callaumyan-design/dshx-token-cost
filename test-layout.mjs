#!/usr/bin/env node
// dshx-token-cost — layout regression check.
//
// jsdom, which `test-client.mjs` uses, has no layout engine: it will happily
// render a table that is 400px wider than its container and report success. So
// this script drives a real browser instead, mounts the panel at several
// viewport widths, and measures whether anything overflows horizontally.
//
// The check exists because of a real report: eight `nowrap` columns under the
// default `table-layout: auto` made the table wider than its card, which pushed
// a page-level horizontal scrollbar and clipped the cost column off the right
// edge. Anything that reintroduces that shows up here as a non-zero overflow.
//
// Requires Chrome (or Edge). Set CHROME to override the search path. Exits 0
// with a note if no browser is found, so it never breaks a headless CI run.
//
// Two failure modes are checked, because fixing one can hide the other:
//
//   * overflow — content wider than its container, which is what produced the
//     page-level horizontal scrollbar;
//   * truncation — content clipped by `text-overflow: ellipsis`, which is what
//     a fixed-layout table does instead of overflowing. A number rendered as
//     `1,460,3…` is not an improvement over a scrollbar.
//
// Set CLIENT_PATH to check a different build of the client half, which is how
// this was validated against the layout that was reported broken.
//
// Run:  node test-layout.mjs [--shot]

import { promises as fs, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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

const execFileAsync = promisify(execFile)

const WORKSPACE = process.env.DSHX_TEST_NODE_MODULES ?? path.resolve('node_modules')
const SANDBOX = path.join(os.tmpdir(), 'dshx-token-cost-layout-check')

const CHROME_CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate) => typeof candidate === 'string' && candidate.length > 0)

/**
 * Viewport widths to check.
 *
 * Each is a whole window; the harness reserves 220px for a sidebar, so the pane
 * the panel actually gets is 220px less (minus the scrollbar). The range covers
 * a maximised window down to a small one, which is where the reported overflow
 * showed up. `LAYOUT_WIDTHS=900,700` overrides it, which is how the narrow end
 * of the range was probed.
 */
const WIDTHS = (process.env.LAYOUT_WIDTHS !== undefined && process.env.LAYOUT_WIDTHS !== ''
  ? process.env.LAYOUT_WIDTHS.split(',')
  : ['1400', '1100', '900', '800', '700', '640'])
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)

async function findBrowser() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      // Try the next one.
    }
  }
  return null
}

// ---- a real payload, from the real host half ------------------------------

const credentials = { async resolve() { return { value: 'sk-test' } } }
const subprocess = {
  async resolveExecutable() { return 'curl' },
  spawn(options) {
    // Routed on the URL the real call puts in curl's stdin config.
    const config = options?.stdio?.stdin?.data ?? ''
    const match = /url = "([^"]+)"/.exec(config)
    const url = match === null ? '' : match[1]
    let text = '{}'
    if (url.includes('deepseek.com')) {
      // Two wallets, in the order that used to decide the headline by accident:
      // the platform does not order them stably.
      text = JSON.stringify({
        is_available: true,
        balance_infos: [
          { currency: 'USD', total_balance: '21.08', granted_balance: '0.00', topped_up_balance: '21.08' },
          { currency: 'CNY', total_balance: '88.40', granted_balance: '0.00', topped_up_balance: '88.40' },
        ],
      })
    } else if (url.includes('open.er-api.com')) {
      text = JSON.stringify({ result: 'success', time_last_update_unix: 1791676951, rates: { CNY: 6.706851 } })
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
const webServer = { register(route) { hostRoute = route; return () => { hostRoute = null } } }
hostApply({
  get: (key) => ({ credentials, subprocess, webServer })[key],
  effect: (fn) => fn(),
  webServer,
})

const payload = await new Promise((resolve, reject) => {
  const chunks = []
  const res = {
    writeHead() { /* not asserted here */ },
    end(body) {
      if (body !== undefined) chunks.push(Buffer.from(String(body)))
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    },
    on() { /* unused */ },
  }
  Promise.resolve(hostRoute.handler({ method: 'GET', url: '/dshx-token-cost/report?days=90' }, res))
    .catch(reject)
})

// ---- the harness page -----------------------------------------------------

/** Which build of the client half to check. */
const CLIENT_FILE = process.env.CLIENT_PATH !== undefined && process.env.CLIENT_PATH !== ''
  ? path.resolve(process.env.CLIENT_PATH)
  : fileURLToPath(new URL('./client.js', import.meta.url))

const CLIENT_SOURCE = await fs.readFile(CLIENT_FILE, 'utf8')

/**
 * Build the page the browser will load.
 *
 * The panel is mounted as a flex child next to a fixed-width sidebar, which is
 * how a settings pane actually sits in the app. The `#pane` deliberately does
 * NOT set `min-width: 0`: a flex item's automatic minimum size is its content's
 * min-content width, so a table whose columns cannot shrink will widen the pane
 * and push a page-level scrollbar. That mechanism is the reported bug, and a
 * plain block container — which simply overflows its children — does not
 * reproduce it.
 */
function harness() {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>dshx-token-cost layout</title>',
    '<style>',
    '  html, body { margin: 0; padding: 0; background: #f4f5f7; color: #16181d;',
    '    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }',
    '  #app { display: flex; align-items: stretch; min-height: 100vh; }',
    '  #nav { flex: 0 0 220px; background: #e9ebef; }',
    '  #pane { flex: 1 1 auto; }',
    '</style></head><body>',
    '<div id="app"><div id="nav"></div><div id="pane"><div id="host"></div></div></div>',
    '<script src="react.js"></script>',
    '<script src="react-dom.js"></script>',
    '<script>window.__PAYLOAD__ = ' + JSON.stringify(payload) + ';</script>',
    '<script>window.__ModuleLoader__ = { load: function (def) { window.__DEF__ = def } };</script>',
    // `#custom` seeds a stored custom range before the panel mounts, which is
    // how the date fields get into a screenshot without a click to drive.
    '<script>',
    'if (window.location.hash === "#custom") {',
    '  var pad = function (n) { return n < 10 ? "0" + n : String(n) }',
    '  var key = function (d) {',
    '    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())',
    '  }',
    '  var to = new Date(); to.setHours(0, 0, 0, 0)',
    '  var from = new Date(to.getTime()); from.setDate(from.getDate() - 29)',
    '  window.localStorage.setItem("dshx-token-cost/prefs", JSON.stringify({',
    '    range: { kind: "custom", from: key(from), to: key(to) }, currency: "CNY" }))',
    '}',
    '</script>',
    '<script src="client.js"></script>',
    '<script>',
    '(function () {',
    '  function finish(result) { document.title = "PROBE:" + encodeURIComponent(JSON.stringify(result)) }',
    '  try {',
    '    var client = window.__DEF__.factory(function (name) {',
    '      if (name === "react") return window.React',
    '      throw new Error("unexpected require: " + name)',
    '    })',
    '    var Panel = null',
    '    client.apply({ slots: {',
    '      inject: function (n, f) { return f() },',
    '      register: function (meta, comp) { Panel = comp },',
    '    } })',
    '    if (!Panel) throw new Error("client registered no component")',
    '',
    '    window.fetch = function () {',
    '      return Promise.resolve({ ok: true, status: 200, json: function () {',
    '        return Promise.resolve(window.__PAYLOAD__)',
    '      } })',
    '    }',
    '',
    '    var host = document.getElementById("host")',
    '    var root = window.ReactDOM.createRoot(host)',
    '    root.render(window.React.createElement(Panel))',
    '',
    '    function measure() {',
    '      var pane = document.getElementById("pane")',
    '      var paneRect = pane.getBoundingClientRect()',
    '      var all = document.querySelectorAll("*")',
    '      var offenders = []',
    '      for (var i = 0; i < all.length; i++) {',
    '        var el = all[i]',
    '        if (el.id === "pane" || el.id === "app" || el.id === "nav") continue',
    '        var r = el.getBoundingClientRect()',
    '        if (r.width === 0 || r.height === 0) continue',
    '        var over = Math.round(r.right - paneRect.right)',
    '        if (over <= 1) continue',
    '        offenders.push({ over: over, tag: el.tagName.toLowerCase(),',
    '          text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 34) })',
    '      }',
    '      offenders.sort(function (a, b) { return b.over - a.over })',
    '      var seen = {}',
    '      var top = []',
    '      for (var j = 0; j < offenders.length && top.length < 6; j++) {',
    '        var key = offenders[j].tag + "|" + offenders[j].text',
    '        if (seen[key]) continue',
    '        seen[key] = 1',
    '        top.push(offenders[j])',
    '      }',
    '      var tables = []',
    '      var ts = document.querySelectorAll("table")',
    '      for (var t = 0; t < ts.length; t++) {',
    '        tables.push({ width: Math.round(ts[t].getBoundingClientRect().width),',
    '          scrollWidth: ts[t].scrollWidth, clientWidth: ts[t].clientWidth })',
    '      }',
    '      // A fixed-layout table does not overflow; it clips instead. A cell',
    '      // whose content is wider than the cell means the value is being',
    '      // ellipsised, which for a number is as bad as a scrollbar.',
    '      var truncated = []',
    '      var cells = document.querySelectorAll("td, th")',
    '      for (var c = 0; c < cells.length; c++) {',
    '        var cell = cells[c]',
    '        if (cell.scrollWidth <= cell.clientWidth + 1) continue',
    '        truncated.push({',
    '          text: (cell.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 22),',
    '          over: cell.scrollWidth - cell.clientWidth,',
    '        })',
    '      }',
    '      finish({',
    '        viewport: window.innerWidth,',
    '        docScrollWidth: document.documentElement.scrollWidth,',
    '        docClientWidth: document.documentElement.clientWidth,',
    '        paneWidth: Math.round(paneRect.width),',
    '        paneScrollWidth: pane.scrollWidth,',
    '        paneClientWidth: pane.clientWidth,',
    '        tableCount: tables.length,',
    '        tables: tables,',
    '        offenders: top,',
    '        truncated: truncated,',
    '        rendered: host.textContent.indexOf("每日用量") !== -1,',
    '      })',
    '    }',
    '',
    '    var deadline = Date.now() + 5000',
    '    function wait() {',
    '      var hostEl = document.getElementById("host")',
    '      if (hostEl.textContent.indexOf("每日用量") === -1 && Date.now() < deadline) {',
    '        setTimeout(wait, 40)',
    '        return',
    '      }',
    '      measure()',
    '    }',
    '    wait()',
    '  } catch (error) {',
    '    finish({ error: String(error && error.message ? error.message : error) })',
    '  }',
    '})();',
    '</script>',
    '</body></html>',
  ].join('\n')
}

// ---- run ------------------------------------------------------------------

const browser = await findBrowser()
if (browser === null) {
  console.log('no Chrome or Edge found; skipping the layout check.')
  console.log('Set CHROME=<path to chrome> to run it.')
  process.exit(0)
}

await fs.mkdir(SANDBOX, { recursive: true })
await fs.copyFile(path.join(WORKSPACE, 'react/umd/react.production.min.js'),
  path.join(SANDBOX, 'react.js'))
await fs.copyFile(path.join(WORKSPACE, 'react-dom/umd/react-dom.production.min.js'),
  path.join(SANDBOX, 'react-dom.js'))
await fs.writeFile(path.join(SANDBOX, 'client.js'), CLIENT_SOURCE, 'utf8')
await fs.writeFile(path.join(SANDBOX, 'harness.html'), harness(), 'utf8')

/** `#custom` opens the panel on a stored custom range instead of a preset. */
const HASH = process.env.LAYOUT_HASH ?? ''
const page = 'file:///' + path.join(SANDBOX, 'harness.html').replace(/\\/g, '/') + HASH

console.log(`browser       ${browser}`)
console.log(`client        ${CLIENT_FILE}`)
console.log(`payload       ${payload.usage.models.length} models, ${payload.usage.days.length} days`)
console.log(`checking      ${WIDTHS.join(', ')} px`)
console.log('')

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures += 1
  console.log(`  [${mark}] ${label}${detail === undefined ? '' : '  ' + detail}`)
}

const shots = process.argv.includes('--shot')

for (const width of WIDTHS) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars=false',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--window-size=${width},1600`,
    '--virtual-time-budget=6000',
    '--dump-dom',
    page,
  ]

  let stdout
  try {
    ({ stdout } = await execFileAsync(browser, args, { maxBuffer: 64 * 1024 * 1024 }))
  } catch (error) {
    // Chrome exits non-zero on some builds even when it produced the DOM.
    stdout = String(error.stdout || '')
    if (stdout === '') {
      console.log(`  [FAIL] ${width}px — browser run failed: ${error.message}`)
      failures += 1
      continue
    }
  }

  const match = /PROBE:([A-Za-z0-9%._~!*'()-]+)/.exec(stdout)
  if (match === null) {
    console.log(`  [FAIL] ${width}px — no probe result in the dumped DOM`)
    failures += 1
    continue
  }
  const result = JSON.parse(decodeURIComponent(match[1]))

  console.log(`--- viewport ${width}px ---`)
  if (result.error !== undefined) {
    check('panel mounted', false, result.error)
    continue
  }

  check('panel rendered', result.rendered === true)
  const docOver = result.docScrollWidth - result.docClientWidth
  const paneOver = result.paneScrollWidth - result.paneClientWidth
  // The pane is a flex item with `min-width: auto`, so it may legitimately grow
  // past the space left by the sidebar; when it does, the page scrolls.
  const slack = result.paneWidth - (result.docClientWidth - 220)
  check('pane did not outgrow its share of the row', slack <= 1,
    `pane ${result.paneWidth}px, available ${result.docClientWidth - 220}px`)
  check('no page-level horizontal overflow', docOver <= 0,
    `scrollWidth ${result.docScrollWidth} vs clientWidth ${result.docClientWidth}`)
  check('no panel-level horizontal overflow', paneOver <= 0,
    `scrollWidth ${result.paneScrollWidth} vs clientWidth ${result.paneClientWidth}`)
  check('no element crosses the container edge', result.offenders.length === 0,
    result.offenders.map((o) => `${o.tag}+${o.over}px "${o.text}"`).join(' | '))
  check('every table fits its card',
    result.tables.every((t) => t.scrollWidth <= t.clientWidth + 1),
    result.tables.map((t) => `${t.width}px/sw${t.scrollWidth}`).join(' '))
  check('no value is clipped by ellipsis', result.truncated.length === 0,
    result.truncated.map((t) => `"${t.text}" +${t.over}px`).join(' | '))
  check('both tables rendered', result.tableCount === 2, String(result.tableCount))
  console.log('')

  if (shots) {
    const suffix = HASH === '' ? '' : '-' + HASH.replace(/[^a-z0-9]/gi, '')
    const shot = path.join(SANDBOX, `shot-${width}${suffix}.png`)
    await execFileAsync(browser, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--window-size=${width},1600`, '--virtual-time-budget=6000',
      `--screenshot=${shot}`, page,
    ], { maxBuffer: 64 * 1024 * 1024 }).catch(() => {})
    console.log(`  screenshot ${shot}`)
  }
}

console.log('')
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`)
  process.exitCode = 1
} else {
  console.log('all checks passed')
}
