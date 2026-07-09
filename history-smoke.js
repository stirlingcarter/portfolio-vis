const assert = require("node:assert/strict");
// vm sandboxes have their own Array intrinsics; JSON-normalize before deepEqual.
const plain = v => JSON.parse(JSON.stringify(v));
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const dataSource = fs.readFileSync(path.join(__dirname, "data.js"), "utf8");
const pricesSource = fs.readFileSync(path.join(__dirname, "prices.js"), "utf8");
const uiSource = fs.readFileSync(path.join(__dirname, "ui.js"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const stylesSource = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8");

/* ---------- static wiring ---------- */

assert.match(indexSource, /id="history-section"/, "holdings-history section exists");
assert.match(indexSource, /id="history-ranges"/, "range selector container exists");
assert.match(indexSource, /id="group-history-section"/, "grouped history section exists");
assert.match(indexSource, /id="group-history-groups"/, "grouped history selector exists");
assert.match(indexSource, /id="group-history-ranges"/, "grouped history range selector exists");
assert.match(uiSource, /renderHistorySection\(\);/, "renderAll draws the history section");
assert.match(uiSource, /renderGroupedHistorySection\(\);/, "renderAll draws the grouped history section");
assert.match(uiSource, /coldledger\.history\.v1/, "history cache uses its own storage key");
assert.match(uiSource, /historyRange: coerceHistoryRange\(ui\.historyRange\)/, "selected range persists with UI state");
assert.match(uiSource, /historyGroupBy: coerceHistoryGroupBy\(ui\.historyGroupBy\)/, "selected grouped-history split persists with UI state");
assert.match(uiSource, /const HISTORY_GROUP_DIMS = \["Institution", "Ticker", "Account Type", "Category", "Subcategory"\]/, "grouped history exposes requested asset dimensions");
assert.match(uiSource, /const HISTORY_GROUP_ALL = "__all__"/, "grouped history defaults to All");
assert.match(indexSource, /Total assets value history/, "history section is labeled as total assets value");
assert.match(indexSource, /plus other assets held flat at current value/, "history note explains the flat add-on");
assert.match(uiSource, /<span class="tt-k">total assets<\/span> <span><\/span>/, "history tooltip skeleton reports total assets");
assert.match(uiSource, /Data\.isAsset\(inv\) && !pricedByHistory\.has\(inv\)/, "unpriced assets ride on top of the series");
assert.match(uiSource, /series\.values = series\.values\.map\(v => v \+ flatAssetValue\)/, "flat add-on shifts every point so the line tracks total assets");
assert.match(uiSource, /const currentAssetTotal = Data\.assetTotal\(ui\.taxOn\);/, "history chart anchors to the same asset total as the headline");
assert.match(uiSource, /currentAssetTotal - currentChartValue/, "history chart absorbs live-price vs stamped-ledger drift");
assert.match(uiSource, /series\.values = series\.values\.map\(v => v \+ headlineAnchorAdjustment\)/, "history chart right edge matches headline assets");
assert.match(uiSource, /function drawGroupedHistoryChart\(container, legend, lines, spec\)/, "grouped history has its own chart renderer");
assert.match(uiSource, /class: "chart-svg group-history-chart-svg"/, "grouped history uses its own edge-to-edge SVG class");
assert.match(uiSource, /groupedHistoryLineSeries/, "grouped history builds one line per selected group");
assert.match(uiSource, /function historyValueDomain\(values\)/, "history chart uses an explicit y-domain helper");
assert.match(uiSource, /const HISTORY_CHART_GEOMETRY = Object\.freeze\(\{[\s\S]*?padLeft: 0,\s*padRight: 0,[\s\S]*?\}\);/, "history chart has no horizontal padding (full-bleed line)");
assert.match(uiSource, /const plotBottom = H - padB;/, "history plot bottom is derived from SVG geometry");
assert.match(uiSource, /y2: plotBottom,\s*gradientUnits: "userSpaceOnUse"/, "history fade gradient terminates at the plot bottom");
assert.match(uiSource, /mask: `url\(#\$\{maskId\}\)`/, "history plot layer uses the geometry-tied SVG mask");

function extractUiFunction(name) {
  const start = uiSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const bodyStart = uiSource.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < uiSource.length; i++) {
    if (uiSource[i] === "{") depth++;
    if (uiSource[i] === "}") depth--;
    if (depth === 0) return uiSource.slice(start, i + 1);
  }
  throw new Error(`could not extract ${name}`);
}

function extractUiConst(name) {
  const match = uiSource.match(new RegExp(`const ${name} = [^;]+;`));
  assert.ok(match, `${name} exists`);
  return match[0];
}

function extractCssRule(selector) {
  const start = stylesSource.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} rule exists`);
  const bodyStart = stylesSource.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < stylesSource.length; i++) {
    if (stylesSource[i] === "{") depth++;
    if (stylesSource[i] === "}") depth--;
    if (depth === 0) return stylesSource.slice(start, i + 1);
  }
  throw new Error(`could not extract CSS rule ${selector}`);
}

const historyChartRule = extractCssRule(".history-chart");
assert.doesNotMatch(historyChartRule, /(?:-webkit-)?mask-image|mask-composite/, "history chart wrapper does not own the fade mask");
assert.doesNotMatch(historyChartRule, /--history-(fade-band|label-safe)/, "history fade is not controlled by wrapper percentages");
assert.match(historyChartRule, /width:\s*100vw/, "history chart spans the full viewport width");
assert.match(historyChartRule, /margin-inline:\s*calc\(50% - 50vw\)/, "history chart bleeds to both screen borders");

/* ---------- Robinhood-style chart: no axes, drag-to-scrub ---------- */

const drawHistoryChartSource = extractUiFunction("drawHistoryChart");
assert.doesNotMatch(drawHistoryChartSource, /axis-text/, "history chart renders no axis labels");
assert.doesNotMatch(drawHistoryChartSource, /grid-line/, "history chart renders no grid lines");
assert.match(drawHistoryChartSource, /addEventListener\("pointerdown"/, "history chart scrubbing starts on pointer press");
assert.match(drawHistoryChartSource, /addEventListener\("pointermove"/, "history chart scrubbing follows pointer drags");
assert.match(drawHistoryChartSource, /setPointerCapture/, "touch drags keep scrubbing without lift-and-tap");
assert.match(drawHistoryChartSource, /"vector-effect": "non-scaling-stroke"/, "line thickness is screen-constant, not viewBox-scaled");
assert.match(drawHistoryChartSource, /scrubRaf = requestAnimationFrame\(applyScrub\)/, "scrub work is coalesced to one update per frame");
assert.match(drawHistoryChartSource, /if \(i === scrubIdx\) \{ moveTip\(aimX, scrubY\); return; \}/, "unchanged data point skips tooltip rebuild");
assert.match(drawHistoryChartSource, /getPredictedEvents/, "scrub aims at browser-predicted pointer positions");
assert.match(drawHistoryChartSource, /velX \* SCRUB_LOOKAHEAD_MS/, "scrub extrapolates cursor velocity when prediction is unavailable");
assert.match(drawHistoryChartSource, /settleTimer = setTimeout/, "scrub settles back to the true position once motion stops");
assert.match(drawHistoryChartSource, /tipNodes\.val\.textContent = fmt\$full\(values\[i\]\)/, "tooltip updates text nodes in place, not innerHTML per frame");
assert.match(drawHistoryChartSource, /el\("div", "history-scrub-cross"\)/, "crosshair is an HTML overlay, not an SVG node");
assert.doesNotMatch(drawHistoryChartSource, /plotLayer\.appendChild\(cross\)/, "crosshair is not inside the masked plot layer");
assert.match(drawHistoryChartSource, /cross\.style\.transform = `translate3d/, "crosshair moves via compositor-only transform");
const tooltipRule = extractCssRule("#tooltip");
assert.match(tooltipRule, /left:\s*0;\s*top:\s*0/, "tooltip is transform-anchored at the origin");
const historySvgRule = extractCssRule(".history-chart-svg");
assert.match(historySvgRule, /touch-action:\s*none/, "touch drags scrub the chart instead of scrolling the page");

const domainSandbox = { Math };
vm.runInNewContext([
  extractUiConst("HISTORY_Y_DOMAIN_PADDING_RATIO"),
  extractUiConst("HISTORY_Y_DOMAIN_MIN_PADDING_RATIO"),
  extractUiConst("HISTORY_Y_DOMAIN_MIN_PADDING"),
  extractUiFunction("historyValueDomain"),
  "globalThis.historyValueDomain = historyValueDomain;"
].join("\n"), domainSandbox, { filename: "ui.js#historyValueDomain" });
const paddedDomain = domainSandbox.historyValueDomain([100, 110, 120]);
assert.ok(paddedDomain.yLo < 100 && paddedDomain.yHi > 120, "history y-domain expands beyond data min/max");
assert.ok(paddedDomain.yHi - paddedDomain.yLo >= (120 - 100) * 2.25, "history y-domain intentionally compresses line variation");
assert.equal(domainSandbox.historyValueDomain([0, 1]).yLo, 0, "positive money history domain preserves zero floor");
const flatDomain = domainSandbox.historyValueDomain([500, 500]);
assert.ok(flatDomain.yLo < 500 && flatDomain.yHi > 500, "flat positive history still gets visible domain padding");

/* ---------- Prices.history (no network for USD; parsing via stubbed fetch) ---------- */

const HOUR = 3600e3;
const nowSec = Math.floor(Date.now() / 1000);

function fakeFetch(url) {
  const body = url.includes("query1.finance.yahoo.com")
    ? JSON.stringify({
        chart: { result: [{
          meta: { currency: "USD", regularMarketPrice: 110, regularMarketTime: nowSec },
          timestamp: [nowSec - 7200, nowSec - 3600, nowSec - 1800],
          indicators: { quote: [{ close: [100, null, 105] }] }
        }] }
      })
    : JSON.stringify({
        prices: [[Date.now() - 2 * HOUR, 50000], [Date.now() - HOUR, 51000], [Date.now(), 52000]]
      });
  return Promise.resolve({ ok: true, text: async () => body });
}

const priceSandbox = {
  fetch: fakeFetch,
  AbortController,
  setTimeout,
  clearTimeout,
  Date, Math, JSON, Number, String, Array, Object, Set, Map, Promise, Error, isFinite, encodeURIComponent, console
};
vm.runInNewContext(`${pricesSource}\nglobalThis.Prices = Prices;`, priceSandbox, { filename: "prices.js" });
const { Prices } = priceSandbox;

const RANGE_KEYS = ["1h", "24h", "3d", "1w", "2w", "1m", "1y", "5y", "10y", "20y"];
assert.deepEqual(plain(Prices.HISTORY_RANGES.map(r => r.key)), RANGE_KEYS, "all ten look-back ranges are published");
Prices.HISTORY_RANGES.forEach(r => {
  assert.ok(r.ms > 0 && r.ttlMs > 0 && r.yahoo && r.yahoo.range && r.yahoo.interval, `range ${r.key} is fully specified`);
});
const beyondCoinGecko = Prices.HISTORY_RANGES.filter(r => r.coingeckoDays === null).map(r => r.key);
assert.deepEqual(plain(beyondCoinGecko), ["5y", "10y", "20y"], "crypto history stops at the CoinGecko 365-day free cap");

async function historySmoke() {
  const usd = await Prices.history("USD", "1h");
  assert.equal(usd.source, "Fixed USD", "USD resolves locally");
  assert.ok(usd.points.every(p => p[1] === 1), "USD history is flat $1");

  const stock = await Prices.history("QQQ", "1w");
  assert.equal(stock.source, "Yahoo Finance");
  assert.deepEqual(plain(stock.points.map(p => p[1])), [100, 105, 110], "null candles dropped, live price appended");

  const coin = await Prices.history("BTC", "24h");
  assert.equal(coin.source, "CoinGecko");
  assert.equal(coin.points.length, 3, "CoinGecko prices parsed");

  await assert.rejects(() => Prices.history("BTC", "5y"), /1y look-back/, "crypto beyond 365d throws without a network call");

  const many = await Prices.historyMany(["USD", "QQQ", "BTC"], "24h");
  assert.deepEqual([...many.results.keys()].sort(), ["BTC", "QQQ", "USD"], "historyMany resolves each ticker once");
  assert.equal(many.errors.size, 0, "no errors for supported tickers");

  const mixed = await Prices.historyMany(["BTC", "ETH"], "5y");
  assert.equal(mixed.results.size, 0, "unsupported crypto ranges resolve nothing");
  assert.equal(mixed.errors.size, 2, "each unsupported ticker reports its error");
}

/* ---------- Data.historyValueSeries ---------- */

const dataSandbox = {};
vm.runInNewContext(`${dataSource}\nglobalThis.Data = Data;`, dataSandbox, { filename: "data.js" });
const { Data } = dataSandbox;

const T0 = 1000e3;
Data.loadArray([
  { "ID": 1, "Ticker": "QQQ", "Institution": "RH", "Account Type": "Brokerage", "Kind": "Asset", "Amount": 2, "Value": 1000, "Category": "Stock", "Subcategory": "", "Nominal Rate": 0.08, "Nominal tax rate": 0.5 },
  { "ID": 2, "Ticker": "QQQ", "Institution": "RH", "Account Type": "Roth IRA", "Kind": "Asset", "Amount": 1, "Value": 500, "Category": "Stock", "Subcategory": "", "Nominal Rate": 0.08, "Nominal tax rate": 0 },
  { "ID": 3, "Ticker": "USD", "Institution": "Chase", "Account Type": "Checking", "Kind": "Asset", "Amount": 100, "Value": 100, "Category": "Cash", "Subcategory": "", "Nominal Rate": 0, "Nominal tax rate": "" },
  { "ID": 4, "Ticker": "MYSTERY", "Institution": "RH", "Account Type": "Brokerage", "Kind": "Asset", "Amount": 1, "Value": 42, "Category": "Stock", "Subcategory": "", "Nominal Rate": 0.08, "Nominal tax rate": "" },
  { "ID": 5, "Ticker": "LOAN", "Institution": "Bank", "Account Type": "Loan", "Kind": "Debt", "Amount": 40, "Value": 40, "Category": "Loan", "Subcategory": "", "Nominal Rate": 0, "Nominal tax rate": "" }
]);
assert.equal(Data.assetTotal(false), 1642, "current asset total remains positive magnitude");
assert.equal(Data.debtTotal(false), 40, "current debt total remains positive magnitude");
assert.equal(Data.total(false), 1602, "current net worth subtracts debt");

const seriesByTicker = new Map([
  ["QQQ", [[T0, 100], [T0 + 2 * HOUR, 120]]],
  ["USD", [[T0, 1], [T0 + 2 * HOUR, 1]]],
  ["LOAN", [[T0, 1], [T0 + 2 * HOUR, 1]]]
]);
const isAssetWithSeriesOrUsd = inv => Data.isAsset(inv);

const out = Data.historyValueSeries(seriesByTicker, {
  start: T0, end: T0 + 2 * HOUR, points: 3, taxOn: false, filter: isAssetWithSeriesOrUsd
});
assert.deepEqual(plain(out.times), [T0, T0 + HOUR, T0 + 2 * HOUR], "grid spans start→end inclusive");
// 3 QQQ shares × price + 100 USD × $1; step interpolation holds 100 until the 120 print.
assert.deepEqual(plain(out.values), [400, 400, 460], "value = current shares × past price, step-interpolated");
assert.equal(out.included.length, 3, "both QQQ lots and USD are included");
assert.deepEqual(plain(out.excluded.map(i => i.Ticker)), ["MYSTERY"], "holdings without a series are excluded, debts filtered out");

const taxed = Data.historyValueSeries(seriesByTicker, {
  start: T0, end: T0 + 2 * HOUR, points: 2, taxOn: true, filter: isAssetWithSeriesOrUsd
});
// Post-tax: lot 1 (2 sh, 50% tax) counts as 1 share; lot 2 unchanged; USD untaxed ("").
assert.deepEqual(plain(taxed.values), [300, 340], "post-tax history scales each lot by its own tax rate");

const flat = Data.historyValueSeries(seriesByTicker, {
  start: T0 - 4 * HOUR, end: T0 - 3 * HOUR, points: 2, taxOn: false, filter: isAssetWithSeriesOrUsd
});
assert.deepEqual(plain(flat.values), [400, 400], "times before the first print flat-extend the earliest price");

const netHistory = Data.historyValueSeries(seriesByTicker, {
  start: T0, end: T0 + 2 * HOUR, points: 3, taxOn: false, filter: () => true
});
assert.deepEqual(plain(netHistory.values), [360, 360, 420], "net history subtracts debt holdings when debts are included");
assert.deepEqual(plain(netHistory.excluded.map(i => i.Ticker)), ["MYSTERY"], "net history still excludes holdings without a series");

historySmoke()
  .then(() => console.log("ok - holdings history ranges, price parsing, and value series"))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
