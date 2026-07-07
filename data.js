/* ============================================================
   DATA LAYER — no DOM, no rendering. Pure state + math.
   The UI layer (ui.js) only ever calls into this module.
   ============================================================ */

const Data = (() => {

  /* ---------- schema ----------
     "Amount" = number of SHARES held (decimal).
     "Value"  = dollar valuation, derived from Amount × price ("" until priced).
     All rates are decimals; growth rates are real (inflation baked in).
  ------------------------------- */

  const FIELD_ORDER = [
    "ID", "Ticker", "Institution", "Account Type", "Amount",
    "Value", "Kind", "Category", "Subcategory", "Nominal Rate", "Nominal tax rate",
    "Amort Months", "Amort Payment"
  ];

  // "Kind" is a binary asset/debt tag, orthogonal to Category. A user is free to
  // name Category "Mortgage" or "Loan"; Kind is what makes a position subtract
  // from net worth. Anything not explicitly "Debt" is treated as an asset.
  const KINDS = ["Asset", "Debt"];

  const DEFAULTS = {
    "Kind": "Asset",
    "Nominal Rate": 0.08,
    "Nominal tax rate": 0.1
  };

  // Known enum-ish suggestions (tags are open-ended strings).
  const SUGGESTIONS = {
    "Account Type": ["Brokerage", "Roth IRA", "Trad IRA", "HSA", "401k", "Checking", "Savings", "Wallet"],
    "Category": ["Stock", "Bond", "Loan", "Mortgage", "Cash", "Crypto", "Real Estate"],
    "Subcategory": ["Growth Stocks", "Index", "Dividend", "parental", "cc", "Emergency Fund"],
    "Institution": ["Robinhood", "Fidelity", "Vanguard", "Schwab", "Chase", "Coinbase"]
  };

  // The dimensions every breakdown chart is built on.
  const TAG_DIMENSIONS = ["Institution", "Account Type", "Kind", "Category", "Subcategory", "Ticker"];

  /* ---------- store ---------- */

  let investments = [];
  let listeners = [];

  function notify() { listeners.forEach(fn => fn()); }
  function subscribe(fn) { listeners.push(fn); }

  function nextId() {
    return investments.reduce((m, i) => Math.max(m, Number(i.ID) || 0), 0) + 1;
  }

  function coerce(raw) {
    const inv = {};
    inv["ID"] = Number(raw["ID"]);
    inv["Ticker"] = String(raw["Ticker"] ?? "").trim();
    inv["Institution"] = String(raw["Institution"] ?? "").trim();
    inv["Account Type"] = String(raw["Account Type"] ?? "").trim();
    inv["Amount"] = Number(raw["Amount"]) || 0;
    inv["Value"] = raw["Value"] === "" || raw["Value"] == null ? "" : Number(raw["Value"]);
    inv["Kind"] = String(raw["Kind"] ?? "").trim().toLowerCase() === "debt" ? "Debt" : "Asset";
    inv["Category"] = String(raw["Category"] ?? "").trim();
    inv["Subcategory"] = String(raw["Subcategory"] ?? "").trim();
    inv["Nominal Rate"] = raw["Nominal Rate"] === "" || raw["Nominal Rate"] == null
      ? DEFAULTS["Nominal Rate"] : Number(raw["Nominal Rate"]);
    // Tax is optional — "" means "doesn't apply" (no withdrawal tax at all).
    // Only a truly absent (null/undefined) tax falls back to the default; an
    // explicit "" is preserved so a user can delete it and have it stick.
    inv["Nominal tax rate"] = raw["Nominal tax rate"] === "" ? ""
      : raw["Nominal tax rate"] == null ? DEFAULTS["Nominal tax rate"]
      : Number(raw["Nominal tax rate"]);
    // Amortization is debt-only. "" = none, and non-debts always stay blank so
    // imported or edited asset rows cannot carry hidden debt schedule values.
    inv["Amort Months"] = inv["Kind"] !== "Debt" || raw["Amort Months"] === "" || raw["Amort Months"] == null ? "" : Number(raw["Amort Months"]);
    inv["Amort Payment"] = inv["Kind"] !== "Debt" || raw["Amort Payment"] === "" || raw["Amort Payment"] == null ? "" : Number(raw["Amort Payment"]);
    return inv;
  }

  function add(fields) {
    const inv = coerce({ ...fields, ID: nextId() });
    investments.push(inv);
    notify();
    return inv;
  }

  function remove(id) {
    investments = investments.filter(i => i.ID !== id);
    notify();
  }

  function update(id, fields) {
    const idx = investments.findIndex(i => i.ID === id);
    if (idx === -1) return;
    investments[idx] = coerce({ ...investments[idx], ...fields, ID: id });
    notify();
  }

  function all() { return investments.slice(); }

  // IDs must be unique — the ledger keys edit/update/remove on them. Hand-edited
  // or merged JSON can collide (or omit IDs); reassign any missing/duplicate ID
  // to a fresh max+1 so downstream row identity is always sound.
  function normalizeIds(arr) {
    const seen = new Set();
    let max = 0;
    arr.forEach(i => { const n = Number(i.ID); if (Number.isInteger(n) && n > 0) max = Math.max(max, n); });
    return arr.map(inv => {
      let id = Number(inv.ID);
      if (!Number.isInteger(id) || id <= 0 || seen.has(id)) id = ++max;
      seen.add(id);
      return { ...inv, ID: id };
    });
  }

  function loadArray(arr) {
    if (!Array.isArray(arr)) throw new Error("JSON root must be an array of investments.");
    investments = normalizeIds(arr).map(coerce);
    notify();
  }

  function loadText(text) {
    const trimmed = text.trim();
    loadArray(trimmed === "" ? [] : JSON.parse(trimmed));
  }

  // Export with exact field order. Amount = shares. Value = dollar valuation
  // (derived from shares × price; persisted so saves round-trip, "" if unknown).
  function toJSON() {
    const out = investments.map(inv => {
      const o = {};
      FIELD_ORDER.forEach(k => { o[k] = inv[k]; });
      return o;
    });
    return JSON.stringify(out, null, 2);
  }

  /* ---------- derivations ---------- */

  // Effective withdrawal tax as a number. "" (or non-numeric) means the tax
  // doesn't apply → 0, so the post-tax toggle leaves the position untouched.
  function taxRate(inv) {
    const t = inv["Nominal tax rate"];
    return t === "" || t == null || isNaN(t) ? 0 : Number(t);
  }

  // A debt is "amortized" when it has both a positive months-remaining and a
  // positive monthly payment — then the projection pays it down on schedule
  // instead of letting it ride at its rate.
  function isAmortized(inv) {
    return inv["Kind"] === "Debt"
      && inv["Amort Months"] !== "" && Number(inv["Amort Months"]) > 0
      && inv["Amort Payment"] !== "" && Number(inv["Amort Payment"]) > 0;
  }

  // Price per SHARE, derived from Value ÷ Amount. "" when unpriced or share-less
  // (the ledger shows a dash and lets the user type one in).
  function pricePerShare(inv) {
    if (inv["Value"] === "" || isNaN(inv["Value"])) return "";
    const shares = Number(inv["Amount"]);
    if (!shares) return "";
    return Number(inv["Value"]) / shares;
  }

  // Present dollar value. Amount is SHARES, not dollars.
  // Value = shares × price, stamped at entry time (stand-in for live market data).
  // Fallback when Value is empty: price the shares at $1 each — exact for CASH-style
  // positions, and a visible-but-sane placeholder until the position is (re)priced.
  function presentValue(inv, taxOn) {
    const base = (inv["Value"] !== "" && !isNaN(inv["Value"])) ? Number(inv["Value"]) : inv["Amount"];
    return taxOn ? base * (1 - taxRate(inv)) : base;
  }

  // Signed contribution to NET WORTH: debts subtract. presentValue stays a
  // positive magnitude (composition charts want magnitudes); netValue is what
  // the headline total and the projection are built on.
  function netValue(inv, taxOn) {
    return presentValue(inv, taxOn) * (inv["Kind"] === "Debt" ? -1 : 1);
  }

  // Net worth = assets − debts.
  function total(taxOn) {
    return investments.reduce((s, i) => s + netValue(i, taxOn), 0);
  }
  const isAsset = i => i["Kind"] !== "Debt";
  const isDebt = i => i["Kind"] === "Debt";
  // Gross magnitudes (always positive): invested assets, and total debt owed.
  function assetTotal(taxOn) { return investments.filter(isAsset).reduce((s, i) => s + presentValue(i, taxOn), 0); }
  function debtTotal(taxOn) { return investments.filter(isDebt).reduce((s, i) => s + presentValue(i, taxOn), 0); }

  function weightedRate() {
    const t = investments.reduce((s, i) => s + presentValue(i, false), 0);
    if (t === 0) return 0;
    return investments.reduce((s, i) => s + presentValue(i, false) * i["Nominal Rate"], 0) / t;
  }

  // Group present value by any tag dimension → [{label, value, count}] sorted desc.
  // Optional `filter(inv)` restricts to a subset (e.g. Data.isAsset / isDebt).
  function groupBy(dimension, taxOn, filter) {
    const map = new Map();
    investments.forEach(inv => {
      if (filter && !filter(inv)) return;
      const label = inv[dimension] || "—";
      const cur = map.get(label) || { label, value: 0, count: 0 };
      cur.value += presentValue(inv, taxOn);
      cur.count += 1;
      map.set(label, cur);
    });
    return [...map.values()].sort((a, b) => b.value - a.value);
  }

  // Cross of two tag dimensions → { rows:[rowLabel], cols:[colLabel], cells: {row: {col: value}} }
  function crossTab(rowDim, colDim, taxOn, filter) {
    const rows = new Map();
    const cols = new Set();
    investments.forEach(inv => {
      if (filter && !filter(inv)) return;
      const r = inv[rowDim] || "—", c = inv[colDim] || "—";
      cols.add(c);
      if (!rows.has(r)) rows.set(r, {});
      rows.get(r)[c] = (rows.get(r)[c] || 0) + presentValue(inv, taxOn);
    });
    return { rows: [...rows.keys()], cols: [...cols], cells: Object.fromEntries(rows) };
  }

  /* ---------- projection ----------
     Monthly compounding at each investment's own nominal rate
     (rates are real: inflation is already baked in).
     opts: { years, monthlyTotal, contribIds:Set, contribAmounts?:Map|Object, taxOn }
     By default, contributions are split equally across selected,
     contribution-ELIGIBLE positions. When contribAmounts is supplied, each
     selected position receives its exact monthly amount instead. Amortized
     debts are ineligible — they pay down on their own schedule (months
     remaining × monthly payment), not from the contribution budget. A
     non-amortized debt (e.g. margin) CAN be a target: a positive monthly
     amount pays it down; deselect it to let it ride at its rate.
     Returns { months, series:[{id,label,isDebt,amortized,contributing,values}],
               totals, contrib:{ perTarget, count, total } }
  ------------------------------------ */
  function projection(opts) {
    const { years, monthlyTotal, contribIds, contribAmounts, taxOn } = opts;
    const N = Math.max(1, Math.round(years * 12));
    const exactAmount = id => {
      if (!contribAmounts) return null;
      const raw = typeof contribAmounts.get === "function" ? contribAmounts.get(id) : contribAmounts[id];
      return Math.max(0, Number(raw) || 0);
    };
    const eligibleTargets = investments.filter(i => contribIds.has(i.ID) && !isAmortized(i));
    const targets = contribAmounts
      ? eligibleTargets.filter(i => exactAmount(i.ID) > 0)
      : eligibleTargets;
    const totalContribution = contribAmounts
      ? targets.reduce((sum, i) => sum + exactAmount(i.ID), 0)
      : (targets.length ? monthlyTotal : 0);
    const perTarget = !contribAmounts && targets.length ? monthlyTotal / targets.length : 0;

    const series = investments.map(inv => {
      const rm = inv["Nominal Rate"] / 12;
      const isDebt = inv["Kind"] === "Debt";
      const amort = isAmortized(inv);
      const exact = contribAmounts ? exactAmount(inv.ID) : perTarget;
      const contributing = !amort && contribIds.has(inv.ID) && exact > 0;
      const c = contributing ? exact : 0;
      const taxMult = taxOn ? (1 - taxRate(inv)) : 1;
      const values = new Array(N + 1);
      let v = netValue(inv, false);   // signed: debts are negative
      values[0] = v * taxMult;

      if (amort) {
        // Pay down the balance magnitude: interest at rate (often ~0), then
        // payment, floored at 0. After the schedule ends it stays paid off.
        let mag = Math.abs(v);
        const pay = Number(inv["Amort Payment"]);
        const months = Number(inv["Amort Months"]);
        for (let m = 1; m <= N; m++) {
          if (m <= months && mag > 0) mag = Math.max(0, mag * (1 + rm) - pay);
          values[m] = -mag * taxMult;
        }
      } else {
        for (let m = 1; m <= N; m++) {
          v = v * (1 + rm) + c;
          if (isDebt && v > 0) v = 0;   // a paid-off debt can't flip into an asset
          values[m] = v * taxMult;
        }
      }
      return { id: inv.ID, label: `${inv.Ticker} · ${inv["Account Type"] || "?"}`, isDebt, amortized: amort, contributing, contribution: c, values };
    });

    const totals = new Array(N + 1).fill(0);
    series.forEach(s => s.values.forEach((v, m) => totals[m] += v));
    const months = Array.from({ length: N + 1 }, (_, m) => m);
    return { months, series, totals, contrib: { perTarget, count: targets.length, total: totalContribution } };
  }

  return {
    FIELD_ORDER, DEFAULTS, KINDS, SUGGESTIONS, TAG_DIMENSIONS,
    subscribe, add, remove, update, all, loadArray, loadText, toJSON,
    presentValue, netValue, taxRate, pricePerShare, isAmortized, isAsset, isDebt,
    total, assetTotal, debtTotal, weightedRate, groupBy, crossTab, projection
  };
})();
