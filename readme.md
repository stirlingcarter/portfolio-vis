# ColdData Ledger

A fully local, single-page portfolio dashboard. No build step, no framework, no
server required, no data leaves the machine. Open `index.html` and go.

## Directory

```
index.html    — page shell: layout, sections, form markup, control elements
styles.css    — presentation styling only (petrol/brass theme, responsive)
data.js       — DATA LAYER: schema, store, derivations, projection math (zero DOM)
prices.js     — PRICE LAYER: live quote lookups (Yahoo + CoinGecko), zero DOM/state
portfolios.js — PERSISTENCE LAYER: named copies in localStorage, syncs with Data
ui.js         — PRESENTATION LAYER: rendering, hand-rolled SVG charts, wiring
tickers.json  — first-run seed / import-export file (no longer the live store)
readme.md     — this file
```

Load order matters: `index.html` loads `data.js`, then `prices.js`, then
`portfolios.js`, then `ui.js`.

## Architectural rule (do not break)

**Strict data/presentation separation.**

- `data.js` exposes a single global `Data` (IIFE module). It contains all state,
  all math, and all schema knowledge. It never touches the DOM.
- `ui.js` reads exclusively through `Data`'s public API and re-renders on change
  via `Data.subscribe(fn)`. It never reaches into the store's internals.
- Any new chart belongs in `ui.js`, built on a derivation added to `data.js`
  (`groupBy`, `crossTab`, `projection` are the existing patterns).

## Schema (exact key order, preserved on export)

```json
{
  "ID": 1,
  "Ticker": "QQQ",
  "Institution": "Robinhood",
  "Account Type": "Trad IRA",
  "Amount": 82,
  "Value": 39376.40,
  "Kind": "Asset",
  "Category": "Stock",
  "Subcategory": "Growth Stocks",
  "Nominal Rate": 0.08,
  "Nominal tax rate": 0.1
}
```

Semantics — read carefully, two fields are easy to confuse:

- **`Amount` is a SHARE COUNT** (decimal), not dollars.
- **`Value` is the dollar valuation**, derived as `Amount × price`. The add form
  takes a `$/share` price (the **Fetch** button pulls it live) and stamps `Value`
  at entry; **Refresh prices** restamps every holding from live market data
  (see [Live pricing](#live-pricing-pricesjs)). `""` means unpriced.
- **Fallback:** if `Value` is `""`, the position is valued at $1/share
  (`presentValue` in `data.js`). This is exact for cash-like positions
  (1 share = $1) and a visible placeholder otherwise — the ledger table marks
  such rows with `*`.
- **Price per share** is derived, not stored: `Data.pricePerShare = Value ÷ Amount`.
  The ledger shows it in its own column and both it and `Value` are editable in
  place — editing either recomputes the other (`Value = shares × price`), so a
  price edit updates the stored `Value` on the backend.
- **`Kind`** — binary `"Asset"` | `"Debt"` (default `"Asset"`, anything not
  exactly `"Debt"` coerces to `"Asset"`). Orthogonal to `Category` — name the
  category `"Mortgage"`/`"Loan"` freely; `Kind` is what makes a position
  **subtract from net worth**. `presentValue` stays a positive magnitude (for
  composition charts); `netValue` applies the sign, and `total`/`projection`
  build on `netValue`. `Kind` is also a `TAG_DIMENSION`, so it gets its own donut.
- **`Amort Months` / `Amort Payment`** — debts only, both `""` by default. Set
  both (> 0) to amortize the debt on that schedule in the projection (see
  [Debt amortization](#debt-amortization)). The add form and ledger edit row
  expose them only when `Kind = Debt`; each can be removed with the `−`/`+`
  toggle and is stored as `""` when removed. The ledger shows `↓ 24mo ·
  $500/mo` for an amortizing debt or `carries` for one that rides at its rate.
- `ID` — integer, auto-incremented by the store (`nextId`).
- `Nominal Rate` — annual real growth rate as a decimal; **inflation is already
  baked in**. Default `0.08`.
- `Nominal tax rate` — withdrawal tax as a decimal, default `0.1`, applied as
  `value × (1 − rate)` wherever the post-tax toggle is on. **Optional:** it
  doesn't apply to everything, so it can be deleted (the `−`/`+` toggle in the
  form and ledger). Stored as `""` when removed; `Data.taxRate` treats `""` as 0
  so the post-tax toggle leaves those positions untouched.
- All other fields are free-form string **tags** with enum-like behavior
  (suggestions in `Data.SUGGESTIONS`; every chart groups on
  `Data.TAG_DIMENSIONS = [Institution, Account Type, Kind, Category, Subcategory, Ticker]`).
  Note: `Category` and `Subcategory` keep those keys in the data for
  compatibility, but the UI labels them **Vehicle** and **Vehicle Category**
  (display-only map `DIM_LABELS` in `ui.js`).
- **`Ticker` is required** but need not be a market symbol — a short call-sign up
  to 7 chars (`HOUSE`, `DEBT`, `MORT`) is fine for real estate, loans, etc. Live
  pricing is only attempted when a row *looks tradable* (`looksTradable` in
  `ui.js`: not a debt, not a cash/loan/mortgage/real-estate category, and a
  1–7 letter symbol); everything else keeps its manually entered value.

## Persistence model (`portfolios.js`)

State lives in **localStorage**, keyed `coldledger.portfolios.v1`, and restores
automatically on return. It holds many named **copies** (portfolios), one active:

```
{ activeId, order:[id…], copies:{ id:{ id, name, updatedAt, investments[] } } }
```

- `Portfolios` owns the collection; `Data` holds the *active* copy's positions
  in memory. Switching a copy calls `Data.loadArray`; every `Data` change mirrors
  back into the active copy and writes localStorage (`Data.subscribe`).
- The copy bar (header) drives **New / Duplicate / Rename / Delete** and the
  active-copy `<select>`. Default is a single copy named "Default".
- **First run only:** if there's no saved state, `Portfolios` seeds "Default" by
  fetching an adjacent `tickers.json` (works over HTTP; under `file://` the fetch
  is blocked and it starts empty). After that, localStorage is the source of
  truth and `tickers.json` is just an import/export convenience.
- **Import / export stays manual too:** **Copy JSON** serializes the active copy
  to the clipboard; **Load tickers.json** (file picker) replaces the active
  copy's positions. IDs are normalized to be unique on every load
  (`normalizeIds` in `data.js`) — hand-edited/merged JSON with duplicate or
  missing IDs is repaired so ledger row identity (edit/remove) stays sound.

## Projection math (`Data.projection`)

Per investment, monthly compounding at its own rate:
`v ← v·(1 + r/12) + c` for each month, where `c` is the monthly contribution
for that position. By default, the monthly total is split equally across the
**contribution-eligible** targets the user selected; once the user edits a
target amount, those exact per-position dollar amounts drive the projection.
Debts start negative (`netValue`); a positive `c` on a debt pays it down and
it's clamped at 0 (a paid-off debt can't flip into an asset). Post-tax
multiplies each trajectory by `(1 − taxRate)`.

`Data.projection` returns `contrib:{ perTarget, count, total }` so the UI can
show either the equal split ("$X/mo → N positions · $Y each") or the exact plan
("$X/mo exact → N positions") and label each contributing target.

### Debt amortization

A debt with both `Amort Months` (> 0) and `Amort Payment` (> 0) is **amortized**
(`Data.isAmortized`): its balance pays down on that schedule —
`mag ← max(0, mag·(1 + r/12) − payment)` for `Amort Months` months, then it
stays paid off. Interest uses the debt's rate (often ~0 for family loans), so
the rate only really matters for a *non*-amortized debt (e.g. margin) that rides
at its rate until you pay it down. Amortized debts are **locked out of exact
contribution editing** and shown as scheduled-paydown badges — they run on their
own schedule, not the contribution budget.

The signature chart (`stackedArea` in `ui.js`) shows debts as **positive visual
balances** so their size can be compared against assets, while net worth still
uses signed debt values underneath. The y-axis only goes below zero when an
actual asset/projected position goes negative; if net worth is negative because
debt exceeds assets, the net-worth line is clipped at the visible floor and
labelled accordingly. Layers receiving contributions are drawn bolder;
amortizing debts are dashed; a dotted net-worth line runs on top. The projection
controls sit below the chart in a foldable panel.

## Live pricing (`prices.js`)

Two free, keyless sources resolve a ticker to a live USD price:

- **USD** → fixed local quote at exactly `$1` (no external fetch). This makes
  cash-like USD rows deterministic in the add form and price refresh.
- **Stocks / ETFs** (QQQ, VOO, SMH, …) → Yahoo Finance chart endpoint. Yahoo
  sends no CORS headers, so `prices.js` tries a direct fetch first, then falls
  back through public CORS proxies (`corsproxy.io`, then `r.jina.ai` whose
  text-wrapped body is dug out by brace-extraction). Any one being down is
  survivable.
- **Crypto** (BTC, ETH, SOL, …) → CoinGecko simple-price API, which is
  CORS-enabled and needs no key. Ticker→coin-id map is `Prices.CRYPTO_IDS`
  (extend freely); anything not in it is treated as a stock symbol.

Contract: `Prices.quote(ticker)` resolves `{ ticker, price, currency, source }`
or **throws** — callers fall back to a user-entered price. `Prices.quoteMany`
returns a `Map` of only what resolved (never throws). In the UI: the add form's
**Fetch** button fills `$/share`, and the header's **Refresh prices** button
re-prices every holding (`Value = shares × price`), leaving unresolvable tickers
(cash, loans, unknown symbols) for manual entry.

## Net worth vs. invested assets

The dashboard keeps two totals distinct so they never get conflated:

- **Net worth** = `Data.total` = assets − debts (`netValue`). It's the headline
  stat and the "Assets, debts & net worth" balance-sheet strip.
- **Invested assets** = `Data.assetTotal` = gross magnitude of the assets. The
  composition views ("by every tag", "weight & composition") are scoped to
  assets via the `Data.isAsset` filter on `groupBy`/`crossTab`, so their donut
  and bar totals equal what's *invested*, not net worth. Debts get their own
  section (`Data.isDebt` filter), and the debt total is shown but excluded from
  the composition totals.

Positions are labelled `TICKER (Acct)` (`positionLabel` in `ui.js`) wherever a
single holding is listed (contribution chips, projection layers) so the same
ticker in two accounts stays distinguishable. Colors come from a wide,
hue-varied `PALETTE`, cached per label so they stay stable across charts.

## Extension points

- **New breakdowns:** add a dimension name to `TAG_DIMENSIONS` (donut appears
  automatically) or call `crossTab(rowDim, colDim, taxOn)` for a new stacked bar.
- **Editing rows:** each ledger row edits in place via `Data.update(id, fields)`
  (`editRow` in `ui.js`); Enter saves, Escape cancels.
- **More coins:** add `TICKER: "coingecko-id"` to `Prices.CRYPTO_IDS`.

## Gotchas for agents

- Field keys contain spaces (`"Account Type"`, `"Nominal tax rate"`) — always
  bracket-access, and keep `FIELD_ORDER` authoritative for export.
- Charts are hand-rolled SVG (no chart library); colors are assigned per label
  from `PALETTE` via `colorFor` and stay stable within a session.
- Google Fonts are loaded from CDN; offline, the stack falls back to system
  serif/sans/mono and everything still works.
