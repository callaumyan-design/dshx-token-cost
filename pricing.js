// dshx-token-cost — the price book.
//
// This file answers one question: if the tokens this machine burned had been
// bought from the vendor's own API at list price, what would they have cost?
//
// It is deliberately data-only. Nothing here reads the filesystem or the
// network: `index.js` aggregates the token counts, `pricing.js` turns counts
// into money, and the two meet at `costOf`.
//
// ## Units
// Every rate below is USD per 1,000,000 tokens, matching how every vendor
// publishes their own price list — with one exception. DeepSeek and Zhipu
// publish in yuan, so those rules quote the published yuan figure through
// `cny()` and it is converted on the way out. Storing the converted dollar
// figure instead would freeze the rate of the day this file was written into
// the book, and the panel would then report a yuan amount the vendor does not
// charge.
//
// Everything else is USD, and CNY is a presentation currency applied at the end
// through `usdToCny`.
//
// ## Matching
// Rules are tried in order and the first whose `match` accepts the pair wins,
// so put specific rules above general ones. A rule's `match` may test the
// provider, the model id (as a regex), or both.
//
// ## Why rates can be approximate
// Several of these models are reached through subscription plans, reseller
// gateways, or account pools, where no per-token invoice exists at all — the
// whole point of this panel is to *estimate* what the same tokens would cost
// on metered billing. Rates are list prices as published by the vendor on
// 2026-10-11; DeepSeek's current table took effect 2026-09-10 and Google's
// Flash introductory rates are scheduled to double on 2027-01-01.

/**
 * Vendors bill weekdays 09:00–12:00 and 14:00–18:00 Beijing time at double the
 * off-peak rate. The panel cannot know which wall clock a given call ran on
 * without re-deriving the vendor's calendar, so it prices everything at the
 * off-peak rate and says so in the UI. Publish the multiplier here so the note
 * and the number can never disagree.
 */
export const PEAK_MULTIPLIER = 2

/**
 * The offline fallback for USD → CNY.
 *
 * `rate.js` refreshes the live rate once a day; this is what the panel uses
 * when it has never managed to fetch one, and it is also the value the price
 * book's own tests assume.
 */
export const USD_TO_CNY = 7.1

/** The date these rates were last checked against vendor price pages. */
export const PRICES_AS_OF = '2026-10-11'

/**
 * Mark a price as quoted in CNY rather than USD.
 *
 * Used only for vendors whose published list is in yuan. Keeping the published
 * figure and converting it on the way out is what makes the round trip exact:
 * a ¥4.5 quote shown as ¥4.25 — which is what happens when the dollar figure
 * is frozen at one rate and the display converts at another — is a number the
 * vendor does not charge.
 *
 * @param amount - the vendor's published CNY price per 1M tokens.
 */
function cny(amount) {
  return { cny: amount }
}

/** The price fields a rule can carry, in the order {@link costOf} reads them. */
const PRICE_FIELDS = ['in', 'out', 'cacheRead', 'cacheWrite']

/**
 * The price book, most specific rules first.
 *
 * Each rule:
 *   provider  exact provider id, or '*' for any
 *   match     RegExp tested against the model id
 *   label     human name shown in the UI
 *   in        uncached input, USD / 1M   (or `cny(n)` for a yuan list price)
 *   out       output, USD / 1M
 *   cacheRead cache hit, USD / 1M   (absent → falls back to `in`)
 *   cacheWrite cache write, USD / 1M (absent → 0; most vendors do not bill it)
 */
export const RULES = [
  // ---- DeepSeek ----------------------------------------------------------
  // Off-peak list prices effective 2026-09-10. Peak is 2x.
  //
  // One account reaches DeepSeek through several provider ids — the official
  // route plus personal gateways (`deepseek`, `deepseek-account`). A token
  // costs the same whichever pipe it travelled down, so these rules match on
  // the model id alone and are deliberately not provider-scoped.
  {
    provider: '*',
    match: /v4-pro|v4\.1-pro/i,
    label: 'DeepSeek V4 Pro',
    in: cny(4.5),
    out: cny(13.5),
    cacheRead: cny(0.15),
  },
  {
    provider: '*',
    match: /deepseek.*vision/i,
    label: 'DeepSeek V4 Flash Vision',
    in: cny(1),
    out: cny(4),
    cacheRead: cny(0.02),
  },
  {
    provider: '*',
    match: /deepseek/i,
    label: 'DeepSeek Flash',
    in: cny(1),
    out: cny(4),
    cacheRead: cny(0.02),
  },

  // ---- Anthropic ---------------------------------------------------------
  // claude.com/pricing, 2026-10-11.
  {
    provider: '*',
    match: /fable-5\.1/i,
    label: 'Claude Fable 5.1',
    in: 10, out: 50, cacheRead: 0.25, cacheWrite: 12.5,
  },
  {
    provider: '*',
    match: /opus-5-5|opus-5\.5/i,
    label: 'Claude Opus 5.5',
    in: 4, out: 20, cacheRead: 0.20, cacheWrite: 5,
  },
  {
    provider: '*',
    match: /sonnet-5-5|sonnet-5\.5/i,
    label: 'Claude Sonnet 5.5',
    in: 2, out: 10, cacheRead: 0.10, cacheWrite: 2.5,
  },
  {
    provider: '*',
    match: /haiku-5-5|haiku-5\.5/i,
    label: 'Claude Haiku 5.5',
    in: 0.10, out: 0.50, cacheRead: 0.01, cacheWrite: 0.125,
  },
  {
    provider: '*',
    match: /fable-5/i,
    label: 'Claude Fable 5',
    in: 10, out: 50, cacheRead: 1, cacheWrite: 12.5,
  },
  {
    provider: '*',
    match: /opus-5/i,
    label: 'Claude Opus 5',
    in: 5, out: 25, cacheRead: 0.50, cacheWrite: 6.25,
  },
  {
    provider: '*',
    match: /sonnet-5/i,
    label: 'Claude Sonnet 5',
    in: 2, out: 10, cacheRead: 0.20, cacheWrite: 2.5,
  },
  {
    provider: '*',
    match: /opus-4-8|opus-4\.8/i,
    label: 'Claude Opus 4.8',
    in: 5, out: 25, cacheRead: 0.50, cacheWrite: 6.25,
  },
  {
    provider: '*',
    match: /opus-4-7|opus-4\.7/i,
    label: 'Claude Opus 4.7',
    in: 5, out: 25, cacheRead: 0.50, cacheWrite: 6.25,
  },
  {
    provider: '*',
    match: /opus-4-6|opus-4\.6/i,
    label: 'Claude Opus 4.6',
    in: 5, out: 25, cacheRead: 0.50, cacheWrite: 6.25,
  },
  {
    provider: '*',
    match: /opus-4-5|opus-4\.5/i,
    label: 'Claude Opus 4.5',
    in: 5, out: 25, cacheRead: 0.50, cacheWrite: 6.25,
  },
  {
    provider: '*',
    match: /sonnet-4-6|sonnet-4\.6/i,
    label: 'Claude Sonnet 4.6',
    in: 3, out: 15, cacheRead: 0.30, cacheWrite: 3.75,
  },
  {
    provider: '*',
    match: /sonnet-4-5|sonnet-4\.5/i,
    label: 'Claude Sonnet 4.5',
    in: 3, out: 15, cacheRead: 0.30, cacheWrite: 3.75,
  },
  {
    provider: '*',
    match: /haiku-4-5|haiku-4\.5/i,
    label: 'Claude Haiku 4.5',
    in: 1, out: 5, cacheRead: 0.10, cacheWrite: 1.25,
  },
  { provider: '*', match: /haiku/i, label: 'Claude Haiku', in: 1, out: 5, cacheRead: 0.10, cacheWrite: 1.25 },

  // ---- OpenAI ------------------------------------------------------------
  // platform.openai.com/docs/pricing, short-context standard tier.
  { provider: '*', match: /gpt-6\.1-sol/i, label: 'GPT-6.1 Sol', in: 2, out: 10, cacheRead: 0.10, cacheWrite: 2.5 },
  { provider: '*', match: /gpt-6-astra/i, label: 'GPT-6 Astra', in: 10, out: 50, cacheRead: 1, cacheWrite: 12.5 },
  { provider: '*', match: /gpt-6-sol/i, label: 'GPT-6 Sol', in: 2, out: 10, cacheRead: 0.10, cacheWrite: 2.5 },
  { provider: '*', match: /gpt-6-luna/i, label: 'GPT-6 Luna', in: 0.10, out: 0.50, cacheRead: 0.01, cacheWrite: 0.125 },
  { provider: '*', match: /gpt-5\.6-sol/i, label: 'GPT-5.6 Sol', in: 4, out: 20, cacheRead: 0.40, cacheWrite: 5 },
  { provider: '*', match: /gpt-5\.6-terra/i, label: 'GPT-5.6 Terra', in: 2, out: 12, cacheRead: 0.20, cacheWrite: 2.5 },
  { provider: '*', match: /gpt-5\.6-luna/i, label: 'GPT-5.6 Luna', in: 0.20, out: 1.20, cacheRead: 0.02, cacheWrite: 0.25 },
  { provider: '*', match: /oss-120b|gpt-oss/i, label: 'GPT-OSS 120B', in: 0.15, out: 0.60, cacheRead: 0.015 },

  // ---- Google ------------------------------------------------------------
  // ai.google.dev/gemini-api/docs/pricing. 3.6/3.7/3.8 Flash carry an
  // introductory rate that doubles on 2027-01-01.
  { provider: '*', match: /gemini-3\.8-flash|gemini-3\.7-flash|gemini-3\.6-flash|gemini-3-flash-agent/i, label: 'Gemini 3.x Flash', in: 0.75, out: 3.75, cacheRead: 0.075 },
  { provider: '*', match: /gemini-3\.5-flash-lite|gemini-3\.1-flash-lite/i, label: 'Gemini Flash Lite', in: 0.25, out: 1.50, cacheRead: 0.025 },
  { provider: '*', match: /gemini-3\.5-flash/i, label: 'Gemini 3.5 Flash', in: 1.50, out: 9, cacheRead: 0.15 },
  { provider: '*', match: /gemini-3\.1-pro|gemini-pro-agent/i, label: 'Gemini 3.1 Pro', in: 2, out: 12, cacheRead: 0.20 },
  { provider: '*', match: /gemini-3-flash/i, label: 'Gemini 3 Flash', in: 0.50, out: 3, cacheRead: 0.05 },
  { provider: '*', match: /gemini-2\.5-pro/i, label: 'Gemini 2.5 Pro', in: 1.25, out: 10, cacheRead: 0.125 },
  { provider: '*', match: /gemini-2\.5-flash/i, label: 'Gemini 2.5 Flash', in: 0.30, out: 2.50, cacheRead: 0.03 },
  { provider: '*', match: /gemini.*image/i, label: 'Gemini Image', in: 0.75, out: 3.75, cacheRead: 0.075 },
  { provider: '*', match: /gemini/i, label: 'Gemini', in: 0.75, out: 3.75, cacheRead: 0.075 },

  // ---- Moonshot / Kimi ---------------------------------------------------
  // Kimi K3 official API, $3 in / $15 out, $0.30 cached read.
  { provider: '*', match: /k3-256k|kimi-k3|k3/i, label: 'Kimi K3', in: 3, out: 15, cacheRead: 0.30, cacheWrite: 3 },
  { provider: '*', match: /kimi/i, label: 'Kimi', in: 3, out: 15, cacheRead: 0.30, cacheWrite: 3 },

  // ---- Zhipu GLM ---------------------------------------------------------
  // bigmodel.cn list price. GLM-5.3 is ¥8 / ¥28; Flash is ¥0.8 / ¥2.8.
  { provider: '*', match: /glm-5\.3-flash|glm-5-3-flash/i, label: 'GLM-5.3 Flash', in: cny(0.8), out: cny(2.8), cacheRead: cny(0.23) },
  { provider: '*', match: /glm/i, label: 'GLM-5.3', in: cny(8), out: cny(28), cacheRead: cny(2) },

  // ---- xAI ---------------------------------------------------------------
  { provider: '*', match: /grok-4\.7/i, label: 'Grok 4.7', in: 2, out: 10, cacheRead: 0.20 },
  { provider: '*', match: /grok.*image|grok-imagine/i, label: 'Grok Imagine', in: 2, out: 10, cacheRead: 0.20 },
  { provider: '*', match: /grok-4-fast/i, label: 'Grok 4 Fast', in: 0.20, out: 0.50, cacheRead: 0.05 },
  { provider: '*', match: /grok-code-fast/i, label: 'Grok Code Fast', in: 0.20, out: 1.50, cacheRead: 0.02 },
  { provider: '*', match: /grok/i, label: 'Grok', in: 2, out: 10, cacheRead: 0.20 },

  // ---- Reseller gateways -------------------------------------------------
  // The `transfer` / `transfer2` gateways relay named upstream models, so the
  // model-id rules above already caught them. Only genuinely unnamed traffic
  // reaches this row; price it at a mid-tier rate so it is visible, not free.
  { provider: '*', match: /.*/, label: '未定价模型', in: 2, out: 10, cacheRead: 0.20, unpriced: true },
]

/**
 * A synthetic row key for traffic matching no label above, so the UI can warn
 * about it instead of silently under-reporting.
 */
const UNKNOWN = { label: '未知模型', in: 0, out: 0, cacheRead: 0, cacheWrite: 0, unpriced: true }

/**
 * Whether a rule quotes any of its prices in CNY.
 * @param rule a price-book rule.
 */
function quotesInCny(rule) {
  return PRICE_FIELDS.some((field) => rule[field] !== undefined && typeof rule[field] !== 'number')
}

/**
 * Convert a rule's CNY quotes to USD at the given rate.
 *
 * A rule with no CNY quotes — most of the book — is returned unchanged, so the
 * common path allocates nothing.
 *
 * @param rule a price-book rule.
 * @param usdToCny the rate to convert at; the published fallback when absent.
 */
function resolveRule(rule, usdToCny) {
  if (!quotesInCny(rule)) return rule
  const rate = typeof usdToCny === 'number' && Number.isFinite(usdToCny) && usdToCny > 0
    ? usdToCny
    : USD_TO_CNY
  const resolved = Object.assign({}, rule)
  for (const field of PRICE_FIELDS) {
    const value = resolved[field]
    if (value !== undefined && typeof value !== 'number') resolved[field] = value.cny / rate
  }
  return resolved
}

/**
 * Resolve the price row for one provider/model pair.
 * @param provider provider id as recorded in the session log.
 * @param model model id as recorded in the session log.
 * @param usdToCny the live rate, for rules quoted in CNY. Omit to use the
 *   published fallback, which is what a caller that only wants the label wants.
 * @returns the matched rule, or a zero-rate placeholder when nothing matches.
 */
export function rateFor(provider, model, usdToCny) {
  const p = typeof provider === 'string' ? provider : ''
  const m = typeof model === 'string' && model.length > 0 ? model : p
  for (const rule of RULES) {
    if (rule.provider !== '*' && rule.provider !== p) continue
    if (rule.match.test(m)) return resolveRule(rule, usdToCny)
  }
  return UNKNOWN
}

/**
 * Price one token bundle.
 *
 * `cacheWrite` is absent from most vendors' meters and from the harness's own
 * usage record for them, so a missing write rate means "not billed" rather
 * than "billed at the input rate" — vendors that do charge it (Anthropic,
 * OpenAI) state the rate explicitly above.
 *
 * @param rate - a row from {@link rateFor}.
 * @param tokens - input/output/cacheRead/cacheWrite token counts.
 * @returns cost in USD.
 */
export function costOf(rate, tokens) {
  const perM = (n, price) => (Number(n) || 0) * (Number(price) || 0) / 1e6
  const cacheRead = rate.cacheRead === undefined ? rate.in : rate.cacheRead
  return perM(tokens.input, rate.in)
    + perM(tokens.output, rate.out)
    + perM(tokens.cacheRead, cacheRead)
    + perM(tokens.cacheWrite, rate.cacheWrite === undefined ? 0 : rate.cacheWrite)
}

/** Convert a USD amount to CNY at the published rate. */
export function usdToCny(usd) {
  return (Number(usd) || 0) * USD_TO_CNY
}

/**
 * A stable key for one priced row of the report.
 * @param provider provider id.
 * @param model model id.
 * @returns `provider/model`, the raw identity of a call site.
 */
export function rowKey(provider, model) {
  return String(provider) + '/' + String(model)
}

/**
 * The key a report row is actually *grouped* under.
 *
 * One account reaches the same vendor model through several provider ids —
 * the official route plus personal gateways such as `transfer2` or `ki`. Those
 * are different call sites but not different products: a Claude Opus 5 token
 * costs the same whoever relayed it. Grouping by {@link rowKey} would therefore
 * split one model's spend across as many rows as there are pipes, which reads
 * as a bug and makes the table hard to scan.
 *
 * Grouping by the vendor label instead folds every route to a model into one
 * row. The trade-off is that the per-gateway split is no longer visible; the
 * row keeps a `routes` count so the UI can say how many pipes fed it.
 *
 * @param provider provider id.
 * @param model model id.
 * @returns the vendor label, which doubles as the grouping key.
 */
export function bucketKey(provider, model) {
  return rateFor(provider, model).label
}
