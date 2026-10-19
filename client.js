// dshx-token-cost — browser half.
//
// A durable DSH client module: the harness composes it into the page bundle
// because this package declares `dsh.client` and loads as a host row. It
// contributes one Settings page and reads its data from the host half's
// `/dshx-token-cost/report` endpoint.
//
// The page is the merge of two earlier plugins — an account-balance panel and
// a token-cost panel — so it answers, top to bottom:
//
//   1. what is in the account right now;
//   2. what the selected window cost, in both currencies;
//   3. which day spent it;
//   4. which model spent it.
//
// Colours lean on the DSH convention rather than this plugin's taste: cost is
// warm so a large number reads as a caution at a glance, and the currency the
// user did not pick appears smaller, as a conversion hint.
window.__ModuleLoader__.load({
  id: 'dshx-token-cost',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    // Translucent neutrals read correctly in both the light and dark themes
    // without binding this panel to theme tokens it does not own.
    const card = {
      border: '1px solid rgba(127,127,127,0.22)',
      borderRadius: 10,
      padding: '14px 16px',
      background: 'rgba(127,127,127,0.07)',
    }
    const cardTitle = {
      fontSize: 11,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      opacity: 0.55,
      marginBottom: 10,
    }
    const muted = { fontSize: 12, opacity: 0.65 }
    const note = { marginTop: 10, fontSize: 11.5, opacity: 0.6, lineHeight: 1.65 }
    const errorText = { fontSize: 12, color: '#d9534f', lineHeight: 1.6 }
    const warnText = { fontSize: 12, color: '#d29922', lineHeight: 1.6 }

    const grid = {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
      gap: 10,
    }
    const metric = {
      border: '1px solid rgba(127,127,127,0.18)',
      borderRadius: 8,
      padding: '10px 12px',
    }
    const metricLabel = { fontSize: 11, opacity: 0.6 }
    const metricValue = {
      marginTop: 4,
      fontSize: 17,
      fontWeight: 600,
      fontVariantNumeric: 'tabular-nums',
    }
    const metricHint = { marginTop: 2, fontSize: 10.5, opacity: 0.5 }

    // `tableLayout: fixed` is what keeps the page from growing a horizontal
    // scrollbar. With the default `auto` layout the browser sizes columns to
    // their content, so `width: 100%` is only a suggestion: eight `nowrap`
    // columns of numbers pushed the table past its card and the last column
    // fell off the right edge. Fixed layout honours the declared widths
    // exactly, and the cells ellipsize rather than push.
    const table = {
      width: '100%',
      tableLayout: 'fixed',
      borderCollapse: 'collapse',
      fontSize: 12,
    }
    // A step smaller when the panel is narrow, which buys back roughly a
    // character per numeric column — enough to keep `240.22M` from being
    // clipped once the cache columns have been dropped.
    const tableNarrow = Object.assign({}, table, { fontSize: 11.5 })
    const th = {
      textAlign: 'right',
      padding: '6px 5px',
      fontSize: 10.5,
      fontWeight: 600,
      letterSpacing: '0.04em',
      opacity: 0.55,
      borderBottom: '1px solid rgba(127,127,127,0.25)',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
    }
    const td = {
      textAlign: 'right',
      padding: '5px 5px',
      borderBottom: '1px solid rgba(127,127,127,0.12)',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }
    // Horizontal padding is the cheapest width to reclaim on a narrow panel:
    // two px off each side of seven columns is 28px, and unlike the font size
    // it costs nothing in legibility.
    const tdTight = Object.assign({}, td, { padding: '5px 3px' })
    const thTight = Object.assign({}, th, { padding: '6px 3px' })
    // The label column is the only one allowed to wrap: a model name should be
    // readable in full rather than cut off, and it is the one column with slack.
    const tdLabel = Object.assign({}, td, {
      textAlign: 'left',
      fontVariantNumeric: 'normal',
      whiteSpace: 'normal',
      overflowWrap: 'anywhere',
    })

    const button = {
      border: '1px solid rgba(127,127,127,0.35)',
      background: 'transparent',
      color: 'inherit',
      borderRadius: 6,
      padding: '5px 12px',
      fontSize: 12,
      cursor: 'pointer',
    }
    const chip = {
      border: '1px solid rgba(127,127,127,0.35)',
      background: 'transparent',
      color: 'inherit',
      borderRadius: 99,
      padding: '3px 11px',
      fontSize: 11.5,
      cursor: 'pointer',
    }
    const chipActive = Object.assign({}, chip, {
      background: 'rgba(127,127,127,0.22)',
      fontWeight: 600,
    })
    // `colorScheme` is what makes the native date picker follow the app's
    // theme instead of always opening a light calendar.
    const dateInput = {
      border: '1px solid rgba(127,127,127,0.35)',
      background: 'transparent',
      color: 'inherit',
      colorScheme: 'light dark',
      borderRadius: 6,
      padding: '4px 8px',
      fontSize: 12,
      fontFamily: 'inherit',
    }
    const tag = {
      display: 'inline-block',
      padding: '0 6px',
      marginLeft: 6,
      borderRadius: 4,
      fontSize: 10,
      border: '1px solid rgba(127,127,127,0.35)',
      opacity: 0.75,
      verticalAlign: 'middle',
    }
    const badge = {
      display: 'inline-block',
      padding: '1px 8px',
      borderRadius: 99,
      fontSize: 11,
      border: '1px solid rgba(127,127,127,0.35)',
    }

    /** Cost colour: warm, so a large number is legible as a caution. */
    const COST = '#d2691e'

    const nf = new Intl.NumberFormat('zh-CN')

    function count(value) {
      return typeof value === 'number' && Number.isFinite(value) ? nf.format(value) : '—'
    }

    function compact(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (Math.abs(value) >= 1e9) return (value / 1e9).toFixed(2) + 'B'
      if (Math.abs(value) >= 1e6) return (value / 1e6).toFixed(2) + 'M'
      if (Math.abs(value) >= 1e4) return (value / 1e3).toFixed(1) + 'K'
      return String(value)
    }

    /**
     * A token count rounded to three significant digits.
     *
     * Used instead of {@link compact} when the tables are tight. `240M` is four
     * characters where `240.22M` is seven, and across eight columns that
     * difference is the whole argument for shortening rather than dropping
     * something. Three digits is enough to compare rows at a glance, and the
     * exact count is still in the cell's tooltip.
     */
    function compactShort(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const abs = Math.abs(value)
      // Four digits and under stay exact: `2910` is shorter than `2.91K` as
      // well as being the real number.
      if (abs < 1e4) return String(Math.round(value))
      const scale = abs >= 1e9 ? 1e9 : abs >= 1e6 ? 1e6 : 1e3
      const suffix = scale === 1e9 ? 'B' : scale === 1e6 ? 'M' : 'K'
      const scaled = value / scale
      if (Math.abs(scaled) >= 100) return String(Math.round(scaled)) + suffix
      const text = scaled.toFixed(Math.abs(scaled) >= 10 ? 1 : 2)
      // `1.10` and `24.0` read better as `1.1` and `24`.
      return text.replace(/\.?0+$/, '') + suffix
    }

    /**
     * Money in the chosen display currency.
     *
     * Precision is dropped as the amount grows, and sooner when the panel is
     * narrow: `¥1277.24` and `¥35569.83` are the widest strings this column
     * would otherwise hold, and six characters of them is what made the column
     * wide enough to matter. The exact value is always in the cell's tooltip.
     *
     * @param short - drop cents from three figures up rather than four, and
     *   keep only one decimal between ten and a hundred.
     */
    function money(usd, currency, rate, short) {
      if (typeof usd !== 'number' || !Number.isFinite(usd)) return '—'
      const value = currency === 'CNY' ? usd * rate : usd
      const symbol = currency === 'CNY' ? '¥' : '$'
      const abs = Math.abs(value)
      const places = short === true
        ? (abs >= 100 ? 0 : abs >= 10 ? 1 : 2)
        : (abs >= 1000 ? 0 : 2)
      // Sub-cent amounts would render as 0.00 and read as free, so they are
      // shown as a floor instead of a rounded zero.
      if (value > 0 && value < 0.01 && places === 2) return symbol + '<0.01'
      return symbol + value.toFixed(places)
    }

    /** The same amount with full precision, for a tooltip. */
    function moneyExact(usd, currency, rate) {
      if (typeof usd !== 'number' || !Number.isFinite(usd)) return '—'
      const value = currency === 'CNY' ? usd * rate : usd
      return (currency === 'CNY' ? '¥' : '$') + value.toFixed(4)
    }

    /**
     * Format an amount that is already denominated in `currency`.
     *
     * The balance API reports its own currency, so it must not go through
     * `money`, which converts from USD and would relabel a yuan balance as
     * dollars.
     */
    function plain(value, currency, digits) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : ''
      const places = typeof digits === 'number' ? digits : 2
      return symbol + value.toFixed(places) + (symbol === '' ? ' ' + String(currency || '') : '')
    }

    function clock(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      const d = new Date(ms)
      const pad = (n) => (n < 10 ? '0' + String(n) : String(n))
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    }

    /**
     * A short `MM-DD HH:MM` stamp.
     *
     * Used where the time of day alone would mislead: a rate fetched yesterday
     * is exactly the case where the reader needs to see the date.
     */
    function stamp(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      const d = new Date(ms)
      const pad = (n) => (n < 10 ? '0' + String(n) : String(n))
      return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }

    /**
     * Short date for the daily table.
     *
     * `2026-10-11` was wide enough to wrap onto two lines in the date column,
     * which is both ugly and a symptom of the row being squeezed. `MM-DD` is
     * unambiguous inside any window this panel offers, except across a year
     * boundary — so the year comes back when it is not the current one. The
     * full date stays in the cell's tooltip either way.
     */
    function shortDate(key) {
      const text = typeof key === 'string' ? key : ''
      if (text.length < 10) return text || '—'
      return text.slice(0, 4) === String(new Date().getFullYear()) ? text.slice(5) : text
    }

    /**
     * The metric columns, described once and rendered by both tables.
     *
     * Widths are percentages, never pixels. Under `tableLayout: fixed` a pixel
     * width becomes a floor the table cannot shrink below, and a table that
     * cannot shrink makes its pane wider than the window — which is what put a
     * horizontal scrollbar on the page. A percentage resolves against whatever
     * width the table is handed, so the table always fits.
     *
     * `tight` is the share to use once the panel is narrow. It is a narrower
     * share of the same column, never the absence of one: see `metricsFor`.
     *
     * `scope` marks a column as belonging to one table only. The daily table
     * carries cache reads and writes as a single figure — a day's row has no
     * room for two cache columns, and the total is what makes the day
     * comparable — while the per-model table has the room to split them, which
     * is where the split is actually worth reading.
     */
    const METRICS = [
      { key: 'input', label: '输入', width: '10%', tight: '11.5%' },
      { key: 'output', label: '输出', width: '10%', tight: '11.5%' },
      { key: 'cacheRead', label: '缓存读', width: '10.5%', tight: '12%', scope: 'model' },
      { key: 'cacheWrite', label: '缓存写', width: '10.5%', tight: '12%', scope: 'model' },
      {
        key: 'cacheTotal',
        label: '缓存读写',
        tightLabel: '缓存',
        width: '11%',
        tight: '12.5%',
        scope: 'day',
      },
      { key: 'total', label: '合计', width: '11%', tight: '13%', strong: true },
      { key: 'calls', label: '调用', width: '9%', tight: '10%' },
      // The heading, not the column, is what runs out of room first: four CJK
      // glyphs need ~44px, which is more than `¥1277` does.
      { key: 'cost', label: '估算费用', tightLabel: '费用', width: '11.5%', tight: '11.5%' },
    ]

    /** The date column: wide enough for the caret plus `MM-DD`. */
    const DATE_WIDTH = '14%'
    const DATE_WIDTH_TIGHT = '15%'

    /** A column's heading, shortened when the panel is narrow. */
    function labelFor(metric, dense) {
      return dense === true && metric.tightLabel !== undefined ? metric.tightLabel : metric.label
    }

    /**
     * The metrics a table shows, for one scope ('day' or 'model').
     *
     * Every column a table is entitled to is always shown. An earlier version
     * dropped the cache columns once the panel got narrow, which kept the
     * numbers legible but silently removed the answer to "how much of this was
     * served from cache?" — and cache reads are most of the volume, so that is
     * exactly the detail worth keeping. The tables shorten the *numbers*
     * instead: precision that the tooltip still carries is a cheaper thing to
     * give up than a column.
     */
    function metricsFor(scope) {
      return METRICS.filter((metric) => metric.scope === undefined || metric.scope === scope)
    }

    /** The `<colgroup>` spec for a table: one open column, then the metrics. */
    function widthSpec(leading, metrics, dense) {
      const rest = metrics.map((metric) => (dense === true ? metric.tight : metric.width))
      return leading.concat(rest)
    }

    /** Render a `<colgroup>` from a width spec. `null` leaves the column open. */
    function colgroup(widths) {
      return React.createElement('colgroup', null, widths.map((width, index) =>
        React.createElement('col', {
          key: index,
          style: width === null || width === undefined ? undefined : { width: width },
        })))
    }

    /**
     * The number a metric shows for a row.
     *
     * Only `cacheTotal` is derived. The host reports cache reads and writes as
     * separate buckets, and the daily table adds them back together so a day's
     * cache traffic is one comparable figure; the per-model table reads the
     * buckets apart.
     */
    function valueOf(metric, row) {
      if (metric.key === 'cacheTotal') return row.cacheRead + row.cacheWrite
      return row[metric.key]
    }

    /** The tooltip for a metric cell: the exact figure, or the split. */
    function tooltipFor(metric, row) {
      if (metric.key === 'cacheTotal') {
        return '读 ' + count(row.cacheRead) + ' · 写 ' + count(row.cacheWrite)
      }
      return count(row[metric.key])
    }

    /**
     * One metric cell.
     *
     * Token counts are compact and carry the exact figure in their tooltip, and
     * calls are compact too — `2910` rather than `2,910`, which is both
     * narrower and easier to scan. Money keeps its tooltip for the cents that
     * the column format drops.
     */
    function metricCell(metric, row, currency, rate, dense) {
      const value = valueOf(metric, row)
      const base = dense === true ? tdTight : td
      const format = dense === true ? compactShort : compact
      if (metric.key === 'cost') {
        return React.createElement('td', {
          key: metric.key,
          style: Object.assign({}, base, { color: COST, fontWeight: 600 }),
          title: moneyExact(value, currency, rate),
        }, money(value, currency, rate, dense === true))
      }
      if (metric.key === 'calls') {
        return React.createElement('td', {
          key: metric.key,
          style: Object.assign({}, base, { opacity: 0.7 }),
          title: count(value),
        }, format(value))
      }
      // A zero cache-write column reads as `—` rather than `0`, which keeps the
      // per-model table's signal (this model writes cache, that one does not)
      // visible at a glance.
      const blank = metric.key === 'cacheWrite' && !(row.cacheWrite > 0)
      return React.createElement('td', {
        key: metric.key,
        style: metric.strong === true ? Object.assign({}, base, { fontWeight: 600 }) : base,
        title: blank ? undefined : tooltipFor(metric, row),
      }, blank ? '—' : format(value))
    }

    /**
     * Track the panel's own width.
     *
     * The pane the panel is mounted into is sized by the app, not by this
     * plugin, and at roughly 500px there is no arrangement of eight numeric
     * columns that stays readable. Measuring lets the tables drop their least
     * load-bearing columns instead of clipping them.
     *
     * @returns [ref, width] — attach the ref to the element to observe.
     */
    function useWidth() {
      const ref = React.useRef(null)
      const [width, setWidth] = React.useState(0)
      // `useLayoutEffect`, not `useEffect`: the first measurement has to land
      // before the browser paints, or a narrow pane shows the wide column set
      // for one frame and then snaps.
      React.useLayoutEffect(() => {
        const node = ref.current
        if (!node) return undefined
        setWidth(node.clientWidth)
        if (typeof ResizeObserver === 'undefined') return undefined
        // Read `clientWidth` here rather than `entry.contentRect.width`: the
        // content box excludes the panel's own padding, so mixing the two
        // measures made the density flip by 44px depending on which one ran
        // last, and the wide layout then appeared at a width it did not fit.
        const observer = new ResizeObserver(() => setWidth(node.clientWidth))
        observer.observe(node)
        return () => observer.disconnect()
      }, [])
      return [ref, width]
    }

    /**
     * Below this panel width the tables drop to their narrow column set.
     *
     * Sized from measurement rather than taste: the full column set needs about
     * 580px of table to hold `240.22M` and `¥1277` without clipping, and the
     * panel gives up 76px of its width to its own padding and the card's.
     */
    const DENSE_BELOW = 640

    function Metric(props) {
      return React.createElement('div', { style: metric },
        React.createElement('div', { style: metricLabel }, props.label),
        React.createElement(
          'div',
          { style: props.accent ? Object.assign({}, metricValue, { color: COST }) : metricValue },
          props.value,
        ),
        props.hint
          ? React.createElement('div', { style: metricHint }, props.hint)
          : null)
    }

    /** One model table, shared by the daily expansion and the window rollup. */
    function ModelTable(props) {
      const currency = props.currency
      const rate = props.rate
      const rows = props.rows
      const dense = props.dense === true
      const showRoutes = props.showRoutes === true
      if (rows.length === 0) {
        return React.createElement('div', { style: muted }, '该区间没有可归因的模型调用。')
      }
      const metrics = metricsFor('model')
      const labelCell = dense ? Object.assign({}, tdLabel, { padding: '5px 4px' }) : tdLabel
      const headCell = dense ? thTight : th
      return React.createElement('table', { style: dense ? tableNarrow : table },
        colgroup(widthSpec([null], metrics, dense)),
        React.createElement('thead', null,
          React.createElement('tr', null,
            React.createElement('th', { style: Object.assign({}, headCell, { textAlign: 'left' }) }, '模型'),
            metrics.map((metric) => React.createElement('th', { key: metric.key, style: headCell },
              labelFor(metric, dense))))),
        React.createElement('tbody', null,
          rows.map((row) => React.createElement('tr', { key: row.label },
            React.createElement('td', { style: labelCell },
              row.label,
              showRoutes && Array.isArray(row.routes) && row.routes.length > 1
                ? React.createElement('span', { style: tag, title: row.routes.join('\n') },
                    row.routes.length + ' 条路由')
                : null),
            metrics.map((metric) => metricCell(metric, row, currency, rate, dense))))))
    }

    /**
     * The account balance, carried over from the retired usage panel.
     *
     * The headline figure follows the chosen display currency, so switching
     * between ¥ and $ moves the balance too instead of leaving it on whichever
     * wallet the platform listed first.
     */
    function BalanceCard(props) {
      const balance = props.balance
      const wanted = props.currency
      if (!balance) {
        return React.createElement('div', { style: card },
          React.createElement('div', { style: cardTitle }, '账户余额'),
          React.createElement('div', { style: muted }, '读取中…'))
      }
      if (balance.available !== true) {
        return React.createElement('div', { style: card },
          React.createElement('div', { style: cardTitle }, '账户余额'),
          React.createElement('div', { style: errorText }, String(balance.reason || '余额不可用')),
          React.createElement('div', { style: note },
            '余额通过 DEEPSEEK_API_KEY 调用 api.deepseek.com/user/balance 获取；'
            + '可在「设置 → 模型」中配置或更新该密钥。'))
      }
      const currencies = Array.isArray(balance.currencies) ? balance.currencies : []
      // Pick the wallet that matches the chosen display currency, rather than
      // whichever entry happens to come first. The platform reports one entry
      // per wallet and does not order them stably — three consecutive calls
      // returned USD/CNY, CNY/USD, USD/CNY — so taking the first made the
      // headline figure flip at random between visits.
      //
      // The entries are separate wallets, not conversions of one amount: this
      // account holds 21.08 USD *and* 0.61 CNY. So nothing is converted here;
      // if the chosen currency has no wallet, the first one is shown as-is.
      const primary = currencies.find((item) => item.currency === wanted) ?? currencies[0]
      const unit = primary && primary.currency ? primary.currency : ''
      const rest = currencies.filter((item) => item !== primary)
      const children = [
        React.createElement('div', { style: cardTitle, key: 'title' }, '账户余额'),
        React.createElement('div', {
          key: 'main',
          style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
        },
          React.createElement('div', {
            style: { fontSize: 30, fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 },
          }, primary ? plain(primary.total, unit) : '—'),
          React.createElement('span', {
            key: 'badge',
            style: balance.isAvailable === true
              ? Object.assign({}, badge, { color: '#2ea043', borderColor: 'rgba(46,160,67,0.5)' })
              : Object.assign({}, badge, { color: '#d29922', borderColor: 'rgba(210,153,34,0.5)' }),
          }, balance.isAvailable === true ? '可用' : '余额不足')),
      ]
      if (primary) {
        children.push(React.createElement('div', { style: note, key: 'split' },
          '赠送 ' + plain(primary.granted, unit) + '  ·  充值 ' + plain(primary.toppedUp, unit)))
      }
      if (rest.length > 0) {
        children.push(React.createElement('div', { style: note, key: 'more' },
          '另有 ' + rest.map((item) => plain(item.total, item.currency || '')).join('  ·  ')))
      }
      return React.createElement('div', { style: card }, children)
    }

    function Summary(props) {
      const total = props.total
      const meta = props.meta
      const currency = props.currency
      const rate = meta.usdToCny
      const other = currency === 'CNY' ? 'USD' : 'CNY'
      // The harness defines the cache-hit share against the three disjoint
      // prompt-side buckets, so write tokens belong in the denominator too.
      const billedInput = total.input + total.cacheRead + total.cacheWrite
      const cacheReadShare = billedInput > 0
        ? Math.round(total.cacheRead / billedInput * 100)
        : 0

      return React.createElement('div', { style: card },
        React.createElement('div', { style: cardTitle }, '区间汇总'),
        React.createElement('div', { style: grid },
          React.createElement(Metric, {
            label: '估算费用',
            value: money(total.cost, currency, rate),
            accent: true,
            hint: '≈ ' + money(total.cost, other === 'CNY' ? 'CNY' : 'USD', rate),
          }),
          React.createElement(Metric, {
            label: '合计 token',
            value: compact(total.total),
            hint: count(total.total) + ' tokens',
          }),
          React.createElement(Metric, {
            label: '模型调用',
            value: count(total.calls),
            hint: props.dayCount + ' 个有记录的日子',
          }),
          React.createElement(Metric, {
            label: '缓存命中率',
            value: cacheReadShare + '%',
            hint: count(total.cacheRead) + ' 命中 / ' + count(billedInput - total.cacheRead) + ' 未命中',
          })),
        total.reasoning > 0
          ? React.createElement('div', { style: note },
              '另有推理 token ' + count(total.reasoning) + '，按厂商口径单列，未重复计入合计。')
          : null)
    }

    // ---- hourly chart -----------------------------------------------------
    //
    // Bars are tokens, stacked as "fresh" (input + output + cache writes) under
    // cache reads, because cache reads are most of the volume but the cheapest
    // part of it — stacking them separately keeps a tall-but-cheap hour from
    // reading as an expensive one. The line is the estimated cost on its own
    // axis, so token volume and money can be compared hour by hour.

    const CHART_HEIGHT = 168
    const CHART_PAD_TOP = 10
    const CHART_PAD_BOTTOM = 22
    const GUTTER = 46
    /** The timeline draws at most this many days; wider windows show the tail. */
    const TIMELINE_MAX_DAYS = 31
    const BAR_FRESH = 'rgba(88,166,255,0.92)'
    const BAR_CACHE = 'rgba(88,166,255,0.32)'
    const pad2 = (n) => (n < 10 ? '0' + String(n) : String(n))

    /** Round an axis maximum up to a round multiple of a power of ten. */
    function niceMax(value) {
      if (!(value > 0)) return 1
      const power = Math.pow(10, Math.floor(Math.log10(value)))
      const n = value / power
      const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 3 ? 3 : n <= 4 ? 4 : n <= 5 ? 5 : n <= 6 ? 6 : n <= 8 ? 8 : 10
      return step * power
    }

    /** An amount already in the display currency, short, for an axis. */
    function axisMoney(value, currency) {
      const symbol = currency === 'CNY' ? '¥' : '$'
      if (!(value > 0)) return symbol + '0'
      if (value >= 100) return symbol + Math.round(value)
      if (value >= 10) return symbol + value.toFixed(1).replace(/\.0$/, '')
      if (value >= 0.1) return symbol + value.toFixed(2).replace(/\.?0+$/, '')
      return symbol + value.toPrecision(2)
    }

    function emptyHour(date, hour) {
      return {
        date, hour, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        total: 0, calls: 0, cost: 0, models: [],
      }
    }

    /** Add an hour row into an accumulator, merging its models by label. */
    function addHour(target, row) {
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'total', 'calls', 'cost']) {
        target[field] += row[field] || 0
      }
      for (const model of row.models || []) {
        const found = target.models.find((m) => m.label === model.label)
        if (found) {
          found.total += model.total
          found.calls += model.calls
          found.cost += model.cost
        } else {
          target.models.push(Object.assign({}, model))
        }
      }
    }

    /**
     * The points the chart draws.
     *
     * `timeline` is every clock hour of the window in order (up to the current
     * hour today), so idle hours show as gaps. `profile` folds the window onto
     * a single 0–23 day, which answers "what time of day do I spend the most".
     */
    function buildHourSeries(hours, mode, fromDay, toDay) {
      if (mode === 'profile') {
        const points = []
        for (let h = 0; h < 24; h += 1) points.push(emptyHour(null, h))
        for (const row of hours) addHour(points[row.hour], row)
        for (const p of points) p.models.sort((a, b) => b.cost - a.cost)
        return { points, clipped: false }
      }
      const lookup = new Map()
      for (const row of hours) lookup.set(row.date + ' ' + row.hour, row)
      let start = fromDay
      let clipped = false
      const earliest = shiftDays(toDay, -(TIMELINE_MAX_DAYS - 1))
      if (start < earliest) {
        start = earliest
        clipped = true
      }
      const today = todayKey()
      const nowHour = new Date().getHours()
      const points = []
      for (let day = start; day <= toDay && day <= today; day = shiftDays(day, 1)) {
        const last = day === today ? nowHour : 23
        for (let h = 0; h <= last; h += 1) {
          points.push(lookup.get(day + ' ' + h) || emptyHour(day, h))
        }
      }
      return { points, clipped }
    }

    /** `MM-DD HH:00–HH+1:00`, or `HH:00–HH+1:00` for the profile. */
    function hourLabel(point) {
      const span = pad2(point.hour) + ':00–' + pad2(point.hour + 1) + ':00'
      return point.date ? shortDate(point.date) + ' ' + span : '每天 ' + span
    }

    function HourlyChart(props) {
      // The host half is loaded once at startup while the page bundle is
      // rebuilt more eagerly, so after an upgrade the page can be new and the
      // host still old — its response simply has no `hours`. Say so instead of
      // drawing an empty chart that looks like "no usage".
      if (!Array.isArray(props.hours)) {
        return React.createElement('div', { style: card },
          React.createElement('div', { style: cardTitle }, '按小时用量'),
          React.createElement('div', { style: warnText },
            '后台服务仍是旧版本，没有返回小时数据。请完全退出并重新打开 DSH 桌面端'
            + '（不是只刷新页面），首次启动会重建一次索引，约数秒。'))
      }
      return React.createElement(HourlyChartBody, props)
    }

    function HourlyChartBody(props) {
      const hours = props.hours
      const currency = props.currency
      const rate = props.rate
      const mode = props.mode
      const windowDays = props.windowDays || 1
      const conv = currency === 'CNY' ? rate : 1
      const [boxRef, boxWidth] = useWidth()
      const scrollRef = React.useRef(null)
      const [hover, setHover] = React.useState(null)

      const series = React.useMemo(
        () => buildHourSeries(hours, mode, props.fromDay, props.toDay),
        [hours, mode, props.fromDay, props.toDay],
      )
      const points = series.points
      const n = points.length

      // Before the first measurement (and under jsdom, which has no layout)
      // assume a typical pane width rather than drawing nothing.
      const plotWidth = Math.max(120, (boxWidth > 0 ? boxWidth : 640) - 2 * GUTTER)
      const step = n > 0 ? Math.max(mode === 'profile' ? 1 : 4, plotWidth / n) : 1
      const svgWidth = Math.max(plotWidth, n * step)
      const bottom = CHART_HEIGHT - CHART_PAD_BOTTOM
      const plotH = bottom - CHART_PAD_TOP

      let tokPeak = 0
      let costPeak = 0
      for (const p of points) {
        if (p.total > tokPeak) tokPeak = p.total
        if (p.cost * conv > costPeak) costPeak = p.cost * conv
      }
      const tokMax = niceMax(tokPeak)
      const costMax = niceMax(costPeak)
      const yTok = (v) => bottom - (v / tokMax) * plotH
      const yCost = (v) => bottom - (v / costMax) * plotH

      // The newest hour is the interesting one, so a scrolling timeline opens
      // at its right end.
      React.useLayoutEffect(() => {
        const el = scrollRef.current
        if (el) el.scrollLeft = el.scrollWidth
      }, [series, boxWidth])
      React.useEffect(() => setHover(null), [series])

      // Stats come from the raw rows, so they do not depend on the view mode.
      let active = 0
      let sumTok = 0
      let sumCost = 0
      let peakCost = null
      let peakTok = null
      for (const row of hours) {
        if (!(row.calls > 0)) continue
        active += 1
        sumTok += row.total
        sumCost += row.cost
        if (peakCost === null || row.cost > peakCost.cost) peakCost = row
        if (peakTok === null || row.total > peakTok.total) peakTok = row
      }

      const fractions = [0, 0.5, 1]
      const children = []

      // Grid lines.
      for (const f of fractions) {
        const y = bottom - f * plotH
        children.push(React.createElement('line', {
          key: 'g' + f, x1: 0, x2: svgWidth, y1: y, y2: y,
          stroke: 'rgba(127,127,127,' + (f === 0 ? '0.35' : '0.15') + ')',
          strokeWidth: 1,
        }))
      }

      // Bars and hover targets.
      const gap = step >= 8 ? 2 : step >= 5 ? 1 : 0.5
      const barW = Math.max(1, step - gap)
      points.forEach((p, i) => {
        const x = i * step + (step - barW) / 2
        if (p.total > 0) {
          const freshTok = p.total - p.cacheRead
          const yFresh = yTok(freshTok)
          const yAll = yTok(p.total)
          children.push(React.createElement('rect', {
            key: 'f' + i, x, y: yFresh, width: barW, height: Math.max(0, bottom - yFresh),
            fill: BAR_FRESH, opacity: hover === null || hover === i ? 1 : 0.55,
          }))
          children.push(React.createElement('rect', {
            key: 'c' + i, x, y: yAll, width: barW, height: Math.max(0, yFresh - yAll),
            fill: BAR_CACHE, opacity: hover === null || hover === i ? 1 : 0.55,
          }))
        }
        children.push(React.createElement('rect', {
          key: 'h' + i, x: i * step, y: 0, width: step, height: bottom,
          fill: hover === i ? 'rgba(127,127,127,0.12)' : 'transparent',
          onMouseEnter: () => setHover(i),
        }))
      })

      // The cost line.
      if (n > 0 && costPeak > 0) {
        const coords = points.map((p, i) =>
          (i * step + step / 2).toFixed(1) + ',' + yCost(p.cost * conv).toFixed(1))
        children.push(React.createElement('polyline', {
          key: 'cost', points: coords.join(' '), fill: 'none', stroke: COST,
          strokeWidth: 1.6, strokeLinejoin: 'round', pointerEvents: 'none',
        }))
        if (hover !== null && points[hover]) {
          children.push(React.createElement('circle', {
            key: 'dot', cx: hover * step + step / 2, cy: yCost(points[hover].cost * conv), r: 3,
            fill: COST, pointerEvents: 'none',
          }))
        }
      }

      // X labels.
      const textStyle = { fontSize: 10, fill: 'currentColor', opacity: 0.55 }
      if (mode === 'profile') {
        const every = step * 3 >= 30 ? 3 : 6
        points.forEach((p, i) => {
          if (p.hour % every !== 0) return
          children.push(React.createElement('text', Object.assign({
            key: 'x' + i, x: i * step + step / 2, y: CHART_HEIGHT - 6, textAnchor: 'middle',
          }, { style: textStyle }), p.hour + '时'))
        })
      } else {
        const dayWidth = 24 * step
        const dayEvery = Math.max(1, Math.ceil(48 / dayWidth))
        const hourEvery = dayWidth >= 360 ? 3 : dayWidth >= 180 ? 6 : dayWidth >= 110 ? 12 : 0
        let dayIndex = 0
        points.forEach((p, i) => {
          const x = i * step + step / 2
          if (p.hour === 0 || i === 0) {
            if (dayIndex % dayEvery === 0) {
              children.push(React.createElement('text', {
                key: 'd' + i, x: Math.max(x, i === 0 ? 14 : x), y: CHART_HEIGHT - 6,
                textAnchor: i === 0 ? 'start' : 'middle',
                style: Object.assign({}, textStyle, { opacity: 0.75 }),
              }, shortDate(p.date)))
              children.push(React.createElement('line', {
                key: 'dl' + i, x1: i * step, x2: i * step, y1: CHART_PAD_TOP, y2: bottom,
                stroke: 'rgba(127,127,127,0.18)', strokeDasharray: '2 3',
              }))
            }
            dayIndex += 1
          } else if (hourEvery > 0 && p.hour % hourEvery === 0 && windowDays <= 31) {
            children.push(React.createElement('text', {
              key: 'x' + i, x, y: CHART_HEIGHT - 6, textAnchor: 'middle', style: textStyle,
            }, pad2(p.hour)))
          }
        })
      }

      const gutter = (side) => React.createElement('svg', {
        width: GUTTER, height: CHART_HEIGHT, style: { flex: '0 0 auto', display: 'block' },
      }, fractions.map((f) => React.createElement('text', {
        key: f,
        x: side === 'left' ? GUTTER - 6 : 6,
        y: bottom - f * plotH + 3.5,
        textAnchor: side === 'left' ? 'end' : 'start',
        style: Object.assign({}, textStyle, side === 'right' ? { fill: COST, opacity: 0.85 } : null),
      }, side === 'left'
        ? (tokMax * f < 10 ? String(+(tokMax * f).toFixed(1)) : compactShort(tokMax * f))
        : axisMoney(costMax * f, currency))))

      const focus = hover !== null && points[hover]
        ? points[hover]
        : (mode === 'profile'
          ? points.reduce((best, p) => (best === null || p.cost > best.cost ? p : best), null)
          : peakCost)
      const focusText = (() => {
        if (!focus || !(focus.calls > 0)) return hover !== null ? hourLabel(points[hover]) + ' · 无调用' : '悬停柱子查看该小时明细'
        const parts = [
          (hover === null ? '峰值 · ' : '') + hourLabel(focus),
          compact(focus.total) + ' tokens',
          money(focus.cost, currency, rate),
          count(focus.calls) + ' 次调用',
        ]
        if (mode === 'profile' && windowDays > 1) {
          parts.push('日均 ' + compact(Math.round(focus.total / windowDays)) + ' / '
            + money(focus.cost / windowDays, currency, rate))
        }
        return parts.join(' · ')
      })()
      const focusModels = focus && Array.isArray(focus.models) ? focus.models.slice(0, 4) : []

      const modeChips = [['timeline', '时间线'], ['profile', '24 小时分布']].map(([key, label]) =>
        React.createElement('button', {
          key, style: mode === key ? chipActive : chip, onClick: () => props.onMode(key),
        }, label))

      const legendDot = (color, label, line) => React.createElement('span', {
        style: { display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 12 },
      },
        React.createElement('span', {
          style: line
            ? { width: 14, height: 2, background: color, display: 'inline-block' }
            : { width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' },
        }),
        label)

      return React.createElement('div', { style: card },
        React.createElement('div', {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 8, flexWrap: 'wrap', marginBottom: 10,
          },
        },
          React.createElement('div', { style: Object.assign({}, cardTitle, { marginBottom: 0 }) }, '按小时用量'),
          React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, modeChips)),
        React.createElement('div', { style: Object.assign({}, grid, { marginBottom: 12 }) },
          React.createElement(Metric, {
            label: '最贵的一小时',
            value: peakCost ? money(peakCost.cost, currency, rate) : '—',
            accent: true,
            hint: peakCost ? hourLabel(peakCost) + ' · ' + compact(peakCost.total) : '无调用',
          }),
          React.createElement(Metric, {
            label: '单小时最多 token',
            value: peakTok ? compact(peakTok.total) : '—',
            hint: peakTok ? hourLabel(peakTok) + ' · ' + money(peakTok.cost, currency, rate) : '无调用',
          }),
          React.createElement(Metric, {
            label: '活跃小时均值',
            value: active > 0 ? compact(Math.round(sumTok / active)) : '—',
            hint: active > 0 ? '≈ ' + money(sumCost / active, currency, rate) + ' / 小时' : '无调用',
          }),
          React.createElement(Metric, {
            label: '活跃小时数',
            value: count(active),
            hint: '区间共 ' + count(windowDays * 24) + ' 小时',
          })),
        React.createElement('div', {
          ref: boxRef,
          style: { display: 'flex', width: '100%', minWidth: 0 },
          onMouseLeave: () => setHover(null),
        },
          gutter('left'),
          React.createElement('div', {
            ref: scrollRef,
            // `width: 0` + `flex: 1 1 0`: the SVG must never contribute to the
            // pane's intrinsic width. With an `auto` basis its width became the
            // pane's min-content size, the pane grew, the chart measured the
            // bigger box and widened again — a feedback loop to 3000px.
            style: { flex: '1 1 0', width: 0, minWidth: 0, overflowX: 'auto', overflowY: 'hidden' },
          },
            plotWidth > 0
              ? React.createElement('svg', {
                  width: svgWidth, height: CHART_HEIGHT, style: { display: 'block' },
                  role: 'img', 'aria-label': '按小时的 token 用量与估算费用',
                }, children)
              : null),
          gutter('right')),
        React.createElement('div', {
          style: { marginTop: 8, fontSize: 11, opacity: 0.7, display: 'flex', flexWrap: 'wrap', rowGap: 4 },
        },
          legendDot(BAR_FRESH, '输入 + 输出 + 缓存写'),
          legendDot(BAR_CACHE, '缓存读'),
          legendDot(COST, '估算费用（右轴）', true)),
        React.createElement('div', {
          style: {
            marginTop: 8, padding: '8px 10px', borderRadius: 6,
            background: 'rgba(127,127,127,0.07)', fontSize: 12, lineHeight: 1.6,
            fontVariantNumeric: 'tabular-nums', minHeight: 40,
          },
        },
          React.createElement('div', null, focusText),
          focusModels.length > 0 && focus.calls > 0
            ? React.createElement('div', { style: { opacity: 0.65, fontSize: 11.5 } },
                focusModels.map((m) => m.label + ' ' + compact(m.total) + ' / '
                  + money(m.cost, currency, rate)).join('  ·  '))
            : null),
        series.clipped
          ? React.createElement('div', { style: note },
              '时间线最多显示最近 ' + TIMELINE_MAX_DAYS + ' 天；更长的区间可切到「24 小时分布」看整体规律。')
          : null,
        props.available === false
          ? React.createElement('div', { style: warnText },
              '部分会话的索引来自旧版本，尚无小时数据；点「重新统计」后补齐。')
          : null)
    }

    function DayRow(props) {
      const day = props.day
      const [open, setOpen] = React.useState(false)
      const cur = props.currency
      const rate = props.rate
      const dense = props.dense === true
      const metrics = metricsFor('day')
      const top = day.models.length > 0 ? day.models[0] : undefined
      const others = day.models.length - 1
      const dateCell = dense
        ? Object.assign({}, tdTight, { textAlign: 'left', fontVariantNumeric: 'normal' })
        : Object.assign({}, td, { textAlign: 'left', fontVariantNumeric: 'normal' })

      return React.createElement(React.Fragment, null,
        React.createElement('tr', {
          style: { cursor: day.models.length > 0 ? 'pointer' : 'default' },
          onClick: () => setOpen((v) => !v),
        },
          // The date must not wrap. It used to render as two stacked lines
          // because the column was being squeezed by the numeric ones.
          React.createElement('td', {
            style: Object.assign({}, dateCell, { paddingLeft: dense ? 4 : 6 }),
            title: day.date,
          },
            React.createElement('span', {
              style: {
                opacity: 0.5,
                marginRight: dense ? 2 : 3,
                // The caret is decoration, so shrinking it is the cheapest
                // width in the table to reclaim — the date beside it is not.
                fontSize: dense ? 9 : undefined,
              },
            }, day.models.length > 0 ? (open ? '▾' : '▸') : '·'),
            shortDate(day.date)),
          // Only the top model is named; the rest are counted. Spelling out
          // `等 5 个模型` cost ~40px that the numeric columns needed more.
          React.createElement('td', {
            style: Object.assign({}, tdLabel, dense ? { padding: '5px 4px' } : null, { opacity: 0.75 }),
            title: day.models.map((m) => m.label).join('\n'),
          },
            top
              ? React.createElement(React.Fragment, null,
                  top.label,
                  others > 0
                    ? React.createElement('span', { style: { opacity: 0.6 } }, ' +' + others)
                    : null)
              : '—'),
          metrics.map((metric) => metricCell(metric, day, cur, rate, dense))),
        open
          ? React.createElement('tr', null,
              React.createElement('td', {
                colSpan: 2 + metrics.length,
                style: {
                  padding: '10px 8px 14px',
                  borderBottom: '1px solid rgba(127,127,127,0.12)',
                  background: 'rgba(127,127,127,0.05)',
                },
              },
                React.createElement(ModelTable, {
                  rows: day.models,
                  currency: cur,
                  rate,
                  showRoutes: true,
                  dense,
                })))
          : null)
    }

    /**
     * Where the panel remembers the reader's choices.
     *
     * A settings page that forgets which currency you picked is mildly annoying
     * every single time you open it. Storage access can throw — it is absent in
     * some embedded contexts and can be disabled by policy — so every access is
     * guarded, and a failure simply means the defaults.
     */
    const PREFS_KEY = 'dshx-token-cost/prefs'

    function loadPrefs() {
      try {
        const raw = window.localStorage.getItem(PREFS_KEY)
        if (raw === null || raw === '') return {}
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }

    function savePrefs(prefs) {
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
      } catch {
        // Unavailable storage is not a reason to break the page.
      }
    }

    /**
     * The preset windows, in days.
     *
     * `当天` is an ordinary one-day window — the host has always supported
     * `days=1`, so it needs no special case anywhere but the label.
     */
    const RANGE_PRESETS = [
      { days: 1, label: '当天' },
      { days: 7, label: '7 天' },
      { days: 14, label: '14 天' },
      { days: 30, label: '30 天' },
      { days: 90, label: '90 天' },
    ]

    /** The window the panel opens with when nothing is stored. */
    const DEFAULT_RANGE = { kind: 'trailing', days: 30 }

    /**
     * The limit assumed before the first response arrives.
     *
     * The real one travels in `meta.maxDays`, so the client is not a second
     * place where the number can be got wrong; this is only what the panel
     * believes during the first load.
     */
    const FALLBACK_MAX_DAYS = 365

    /** A local `YYYY-MM-DD` key, matching the day keys the host buckets under. */
    function localDayKey(date) {
      const pad = (n) => (n < 10 ? '0' + String(n) : String(n))
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    }

    function todayKey() {
      return localDayKey(new Date())
    }

    /**
     * `key` shifted by `delta` days.
     *
     * `setDate` works on the calendar, so a DST change cannot make the shift
     * land a day off the way adding 24 hours at a time can.
     */
    function shiftDays(key, delta) {
      const [y, m, d] = key.split('-').map(Number)
      const date = new Date(y, m - 1, d)
      date.setDate(date.getDate() + delta)
      return localDayKey(date)
    }

    /** Whether a value is a date the host will accept. */
    function isDayKey(value) {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
      // Round-tripping rejects `2026-02-30`, which `Date` would roll over.
      return localDayKey(new Date(value + 'T00:00:00')) === value
    }

    /**
     * A sane positive day count.
     *
     * Deliberately not clamped to the server's limit: a stored value wider than
     * the limit is the server's to trim, and quietly rewriting the reader's
     * saved choice here would hide that it happened.
     */
    function clampDays(days) {
      return Math.min(3650, Math.max(1, Math.round(days)))
    }

    /**
     * The window to open with, from stored preferences.
     *
     * Older builds stored a bare `days` number, so that shape is migrated
     * rather than thrown away — it was a deliberate choice, and losing it on
     * upgrade is exactly the annoyance this feature exists to remove.
     */
    function readRange(prefs) {
      const stored = prefs.range
      if (stored !== null && typeof stored === 'object') {
        if (stored.kind === 'custom' && isDayKey(stored.from) && isDayKey(stored.to)) {
          return { kind: 'custom', from: stored.from, to: stored.to }
        }
        // The stored value is only the *choice*; the dates follow the calendar,
        // so `当月` opened today means today's month, not the month it was
        // chosen in. That is the whole point of the range, and it is why the
        // window is recomputed here instead of being saved as `from`/`to`.
        if (stored.kind === 'month') return { kind: 'month' }
        if (stored.kind === 'trailing' && Number.isFinite(stored.days)) {
          return { kind: 'trailing', days: clampDays(stored.days) }
        }
      }
      if (Number.isFinite(prefs.days)) return { kind: 'trailing', days: clampDays(prefs.days) }
      return DEFAULT_RANGE
    }

    /**
     * The first and last day of the calendar month `anchor` falls in.
     *
     * Day 1 is exact; the last day is day 0 of the following month, which needs
     * no 28/29/30/31 table and gets leap years right for free. Everything stays
     * local-time, so the month is the reader's month rather than the host's.
     */
    function monthBounds(anchor) {
      const from = localDayKey(new Date(anchor.getFullYear(), anchor.getMonth(), 1))
      const to = localDayKey(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0))
      return { from, to }
    }

    /**
     * The query string for a window, or null when a custom range is incomplete.
     *
     * A half-filled range must not fall back to some other window — that would
     * silently answer a different question — so it asks for nothing and the
     * panel keeps showing what it already has.
     *
     * `now` is injectable so the month window can be tested without waiting for
     * a month to pass; callers in the panel pass nothing.
     */
    function rangeQuery(range, now) {
      if (range.kind === 'month') {
        // The host takes from/to already, so the month needs no server-side
        // kind: it is a custom window whose bounds the calendar supplies.
        const bounds = monthBounds(now === undefined ? new Date() : now)
        return 'from=' + bounds.from + '&to=' + bounds.to
      }
      if (range.kind === 'custom') {
        if (!isDayKey(range.from) || !isDayKey(range.to)) return null
        // A reversed range is normalised by the host, so it can go as typed.
        return 'from=' + range.from + '&to=' + range.to
      }
      return 'days=' + String(clampDays(range.days))
    }

    /**
     * How many days a window spans, both ends inclusive.
     *
     * The walk is bounded only to keep it finite; comparing the result against
     * the server's limit is the caller's job.
     */
    function rangeDays(range, now) {
      if (range.kind === 'month') {
        const anchor = now === undefined ? new Date() : now
        // Day 0 of next month is this month's length.
        return new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate()
      }
      if (range.kind !== 'custom') return range.days
      if (!isDayKey(range.from) || !isDayKey(range.to)) return 0
      const [low, high] = range.from <= range.to
        ? [range.from, range.to]
        : [range.to, range.from]
      let count = 0
      let cursor = low
      while (cursor <= high && count < 4000) {
        count += 1
        cursor = shiftDays(cursor, 1)
      }
      return count
    }

    /** A label for the range, used where the chips cannot show it. */
    function rangeLabel(range, now) {
      if (range.kind === 'month') {
        const anchor = now === undefined ? new Date() : now
        return (anchor.getMonth() + 1) + ' 月'
      }
      if (range.kind !== 'custom') {
        const preset = RANGE_PRESETS.find((item) => item.days === clampDays(range.days))
        return preset === undefined ? clampDays(range.days) + ' 天' : preset.label
      }
      if (!isDayKey(range.from) || !isDayKey(range.to)) return '自定义'
      return range.from <= range.to ? range.from + ' → ' + range.to : range.to + ' → ' + range.from
    }

    function Panel() {
      // Read once per mount; `useState` with a function initialiser keeps it
      // from running on every render.
      const [prefs] = React.useState(loadPrefs)
      const [range, setRange] = React.useState(() => readRange(prefs))
      const [currency, setCurrency] = React.useState(prefs.currency === 'USD' ? 'USD' : 'CNY')
      const [request, setRequest] = React.useState({ nonce: 0, force: false })
      const [state, setState] = React.useState({ phase: 'loading', startedAt: Date.now() })
      const [expanded, setExpanded] = React.useState(false)
      const [hourMode, setHourMode] = React.useState(
        prefs.hourMode === 'profile' ? 'profile' : 'timeline')

      const query = rangeQuery(range)

      // Remember the choices for next time. Written on change rather than on
      // unmount, because the panel is torn down with the settings page and an
      // unmount effect is easy to miss.
      React.useEffect(() => {
        savePrefs({ range, currency, hourMode })
      }, [range, currency, hourMode])

      React.useEffect(() => {
        // An incomplete custom range asks for nothing and leaves the last
        // answer on screen rather than fetching a different window.
        if (query === null) return undefined
        let alive = true
        setState((previous) => ({
          phase: previous.data ? 'refreshing' : 'loading',
          data: previous.data,
          error: previous.error,
          startedAt: Date.now(),
        }))
        const url = '/dshx-token-cost/report?' + query
          + (request.force ? '&force=1' : '')
        fetch(url, { credentials: 'same-origin' })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + String(response.status))
            return response.json()
          })
          .then((data) => {
            if (!alive) return
            setState({ phase: 'ready', data })
          })
          .catch((error) => {
            if (!alive) return
            setState({ phase: 'error', error: error && error.message ? error.message : String(error) })
          })
        return () => {
          alive = false
        }
      }, [query, request])

      const data = state.data
      const busy = state.phase === 'loading'
      const meta = data && data.usage ? data.usage.meta : undefined
      const rate = meta ? meta.usdToCny : 7.1
      // The server reports its own limit; until it has, assume the fallback.
      const maxDays = meta && Number.isFinite(meta.maxDays) ? meta.maxDays : FALLBACK_MAX_DAYS

      // The panel measures itself so the tables can drop columns on a narrow
      // pane instead of letting the browser ellipsise their numbers.
      const [panelRef, panelWidth] = useWidth()
      const dense = panelWidth > 0 && panelWidth < DENSE_BELOW
      const dayMetrics = metricsFor('day')

      const rangeChips = RANGE_PRESETS.map((preset) =>
        React.createElement('button', {
          key: preset.days,
          style: range.kind === 'trailing' && range.days === preset.days ? chipActive : chip,
          onClick: () => setRange({ kind: 'trailing', days: preset.days }),
        }, preset.label))

      // `当月` differs from every other preset in kind, not just in number: a
      // calendar month is 28–31 days depending on when you look, so it cannot be
      // a `days` preset. It follows `当天` — the two the reader picks between
      // when asking "today or this month?" — and leads the trailing windows,
      // which are the "last N days" answers rather than calendar boundaries.
      rangeChips.splice(1, 0, React.createElement('button', {
        key: 'month',
        style: range.kind === 'month' ? chipActive : chip,
        onClick: () => setRange({ kind: 'month' }),
      }, '当月'))

      // Opening the custom range seeds it with whatever is on screen, so the
      // first click never lands on an empty form.
      rangeChips.push(React.createElement('button', {
        key: 'custom',
        style: range.kind === 'custom' ? chipActive : chip,
        onClick: () => setRange((current) => {
          if (current.kind === 'custom') return current
          const to = todayKey()
          return { kind: 'custom', from: shiftDays(to, -(rangeDays(current) - 1)), to }
        }),
      }, '自定义'))

      const setFrom = (event) => setRange((r) => Object.assign({}, r, { from: event.target.value }))
      const setTo = (event) => setRange((r) => Object.assign({}, r, { to: event.target.value }))

      const customRange = range.kind === 'custom'
        ? React.createElement('div', {
            style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' },
          },
            React.createElement('input', {
              type: 'date',
              value: range.from,
              max: range.to,
              'aria-label': '起始日期',
              style: dateInput,
              // Both handlers are bound on purpose. `onChange` is the idiomatic
              // one and is what the app delivers, but under jsdom React does
              // not deliver `change` for a date input while it does deliver
              // `input` — binding both keeps the control working in the app and
              // testable in the suite.
              onChange: setFrom,
              onInput: setFrom,
            }),
            React.createElement('span', { style: muted }, '至'),
            React.createElement('input', {
              type: 'date',
              value: range.to,
              min: range.from,
              'aria-label': '结束日期',
              style: dateInput,
              onChange: setTo,
              onInput: setTo,
            }),
            rangeDays(range) > maxDays
              ? React.createElement('span', { style: warnText },
                  '最长 ' + maxDays + ' 天，将只统计最近的 ' + maxDays + ' 天')
              : null)
        : null

      const curChips = ['CNY', 'USD'].map((c) =>
        React.createElement('button', {
          key: c,
          style: c === currency ? chipActive : chip,
          onClick: () => setCurrency(c),
        }, c === 'CNY' ? '¥ 人民币' : '$ 美元'))

      const usage = data && data.usage
      const dayList = usage && Array.isArray(usage.days) ? usage.days : []
      const shown = expanded ? dayList : dayList.slice(0, 10)

      const statusLine = (() => {
        if (busy) {
          return '正在统计…（首次运行需要读取全部会话日志，约数秒）'
        }
        if (usage && usage.available === true && meta) {
          const parts = []
          // A preset is already named by its chip; a custom range is not, so
          // the window actually answered is echoed here. It also reveals
          // clamping, since the start shown is the one that was used.
          // Presets (including `当月`) share one compact format; only custom
          // ranges echo their dates.
          // `当月` is sent to the host as from/to, so the host reports
          // mode 'custom' for it too; the panel's own choice decides instead.
          if (range.kind === 'custom' && typeof usage.fromDay === 'string') {
            parts.push(usage.fromDay + ' → ' + usage.toDay
              + '（' + count(usage.windowDays) + ' 天）')
          }
          parts.push('已索引 ' + count(meta.sessionsIndexed) + ' 个会话')
          if (meta.decoded > 0) parts.push('本次重读 ' + meta.decoded + ' 个')
          parts.push('用时 ' + (meta.scanMs / 1000).toFixed(2) + 's')
          parts.push('更新于 ' + clock(data.at))
          return parts.join(' · ')
        }
        return '更新于 ' + clock(data ? data.at : undefined)
      })()

      return React.createElement('div', {
        ref: panelRef,
        style: {
          padding: dense ? '16px 12px' : '18px 22px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          color: 'inherit',
          // The panel lives inside the settings pane's own scroll container, so
          // it must never ask for more width than it was given: `minWidth: 0`
          // lets the flex children shrink instead of overflowing, and
          // `border-box` keeps the padding from adding to the width.
          boxSizing: 'border-box',
          maxWidth: '100%',
          minWidth: 0,
        },
      },
        // ---- header -------------------------------------------------------
        React.createElement('div', {
          style: {
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
            gap: 16, flexWrap: 'wrap',
          },
        },
          React.createElement('div', null,
            React.createElement('h2', { style: { margin: 0, fontSize: 15, fontWeight: 600 } }, '用量与费用'),
            React.createElement('div', { style: { marginTop: 4, fontSize: 12, opacity: 0.6 } }, statusLine)),
          React.createElement('button', {
            style: busy ? Object.assign({}, button, { opacity: 0.45, cursor: 'default' }) : button,
            disabled: busy,
            onClick: () => setRequest((r) => ({ nonce: r.nonce + 1, force: true })),
          }, busy ? '统计中' : '重新统计')),

        // ---- filters ------------------------------------------------------
        React.createElement('div', {
          style: { display: 'flex', flexDirection: 'column', gap: 8 },
        },
          React.createElement('div', {
            style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
          },
            React.createElement('span', { style: Object.assign({}, muted, { marginRight: 2 }) }, '区间'),
            rangeChips),
          // The date fields are part of the range control, so they sit directly
          // under it rather than below the currency row.
          customRange,
          React.createElement('div', {
            style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
          },
            React.createElement('span', { style: Object.assign({}, muted, { marginRight: 2 }) }, '计价货币'),
            curChips)),

        // ---- balance ------------------------------------------------------
        React.createElement(BalanceCard, {
          balance: data ? data.balance : undefined,
          currency,
        }),

        // ---- errors -------------------------------------------------------
        state.phase === 'error'
          ? React.createElement('div', { style: card },
              React.createElement('div', { style: errorText },
                '读取失败：' + String(state.error || '')))
          : null,
        usage && usage.available === false
          ? React.createElement('div', { style: card },
              React.createElement('div', { style: errorText }, String(usage.reason || '统计不可用')))
          : null,

        // ---- body ---------------------------------------------------------
        usage && usage.available === true
          ? React.createElement(React.Fragment, null,
              React.createElement(Summary, {
                total: usage.total,
                meta: usage.meta,
                currency,
                dayCount: usage.dayCount,
              }),

              React.createElement(HourlyChart, {
                hours: usage.hours,
                available: usage.hoursAvailable,
                fromDay: usage.fromDay,
                toDay: usage.toDay,
                windowDays: usage.windowDays,
                currency,
                rate,
                mode: hourMode,
                onMode: setHourMode,
              }),

              React.createElement('div', { style: card },
                React.createElement('div', { style: cardTitle }, '每日用量'),
                dayList.length === 0
                  ? React.createElement('div', { style: muted }, '该区间没有模型调用记录。')
                  : React.createElement('table', { style: dense ? tableNarrow : table },
                      colgroup(widthSpec([dense ? DATE_WIDTH_TIGHT : DATE_WIDTH, null], dayMetrics, dense)),
                      React.createElement('thead', null,
                        React.createElement('tr', null,
                          React.createElement('th', {
                            style: Object.assign({}, dense ? thTight : th, { textAlign: 'left' }),
                          }, '日期'),
                          React.createElement('th', {
                            style: Object.assign({}, dense ? thTight : th, { textAlign: 'left' }),
                          }, dense ? '模型' : '主要模型'),
                          dayMetrics.map((metric) => React.createElement('th', {
                            key: metric.key,
                            style: dense ? thTight : th,
                          }, labelFor(metric, dense))))),
                      React.createElement('tbody', null,
                        shown.map((day) => React.createElement(DayRow, {
                          key: day.date,
                          day,
                          currency,
                          rate,
                          dense,
                        })))),
                dayList.length > 10
                  ? React.createElement('div', { style: { marginTop: 10, textAlign: 'center' } },
                      React.createElement('button', {
                        style: button,
                        onClick: () => setExpanded((v) => !v),
                      }, expanded ? '收起' : '展开全部 ' + dayList.length + ' 天'))
                  : null),

              React.createElement('div', { style: card },
                React.createElement('div', { style: cardTitle }, '按模型汇总'),
                React.createElement(ModelTable, {
                  rows: usage.models,
                  currency,
                  rate,
                  showRoutes: true,
                  dense,
                })),

              // ---- footnotes -------------------------------------------------
              React.createElement('div', { style: note },
                React.createElement('div', null,
                  '费用按各厂商公开 API 牌价估算，并非实际账单。',
                  meta && meta.peakMultiplier > 1
                    ? 'DeepSeek 的高峰时段（工作日 09:00–12:00、14:00–18:00）为其两倍，此处统一按空闲价计。'
                    : ''),
                React.createElement('div', null,
                  '牌价核对于 ' + (meta ? meta.pricesAsOf : '—')
                  + '；汇率 1 USD = ¥' + (meta ? meta.usdToCny.toFixed(4) : '—')
                  + (meta && meta.rateIsFallback === true
                      ? '（内置默认值）'
                      : meta && Number.isFinite(meta.rateFetchedAt)
                        ? '（' + (meta.rateSource || '未知来源') + '，' + stamp(meta.rateFetchedAt) + ' 更新）'
                        : '')
                  + '。 统计本机会话日志中的模型调用，'
                  + '含 ' + (meta ? count(meta.sessionsOnDisk) : '—') + ' 个会话'
                  + (meta && meta.routeCount ? '、' + meta.routeCount + ' 条 provider 路由' : '')
                  + '；合计 token 为输入、输出、缓存读、缓存写四项之和。'),
                React.createElement('div', null,
                  '人民币金额按上述汇率折算；DeepSeek、智谱等以人民币定价的模型按其公布的'
                  + '人民币价目计，不受汇率波动影响。'),
                React.createElement('div', null,
                  '本页由「用量统计」与「账户余额」两个插件合并而来，余额一栏直接读取'
                  + ' DeepSeek 平台接口，用量一栏来自本机会话日志。'),
                meta && meta.rateIsFallback === true
                  ? React.createElement('div', { style: warnText },
                      '汇率取自内置默认值 ¥' + (meta.rateFallback ?? '—')
                      + '，联网获取失败；人民币金额可能有偏差，恢复联网后会自动更新。')
                  : null,
                usage && usage.truncated === true
                  ? React.createElement('div', { style: warnText },
                      '所选区间超过 ' + maxDays + ' 天，只统计了最近的 '
                      + maxDays + ' 天（' + usage.fromDay + ' → ' + usage.toDay + '）。')
                  : null,
                meta && Array.isArray(meta.unpricedModels) && meta.unpricedModels.length > 0
                  ? React.createElement('div', { style: warnText },
                      '有 ' + meta.unpricedModels.length + ' 个模型未在价目表中，费用为零：'
                      + meta.unpricedModels.join('、'))
                  : null,
                meta && meta.failed > 0
                  ? React.createElement('div', { style: warnText },
                      meta.failed + ' 个日志读取失败，未计入。')
                  : null),

              React.createElement('div', { style: { fontSize: 11, opacity: 0.4 } },
                'dshx-token-cost v2.1.0 · 持久化插件（随客户端分发）'))
          : null)
    }

    /** Client services this plugin reads. */
    const inject = ['slots']

    /**
     * Register the Settings page once its slot declaration is on the ledger.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dshx-token-cost',
        order: 30,
        label: '用量与费用',
      }, Panel))
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
