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

  const LEVERAGE_LEVELS = [
    { level: "None", maxMargin: 0 },
    { level: "Very Safe", maxMargin: 0.05 },
    { level: "Safe", maxMargin: 0.15 },
    { level: "Normal", maxMargin: 0.25 },
    { level: "Moderate", maxMargin: 0.35 },
    { level: "Aggressive", maxMargin: 0.5 },
    { level: "Very Aggressive", maxMargin: 0.7 },
    { level: "Dangerous", maxMargin: Infinity }
  ];

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

  const EDGE_JUNK_RE = /^[\s\uFEFF\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069]+|[\s\uFEFF\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069]+$/g;
  const WRAPPER_QUOTES = {
    "'": "'",
    '"': '"',
    "`": "`",
    "\u2018": "\u2019",
    "\u2019": "\u2019",
    "\u201C": "\u201D",
    "\u201D": "\u201D"
  };

  function cleanClipboardEdges(value) {
    return String(value ?? "").replace(/\r\n?/g, "\n").replace(EDGE_JUNK_RE, "");
  }

  function previewText(value) {
    const oneLine = cleanClipboardEdges(value).replace(/\s+/g, " ");
    const short = oneLine.length > 120 ? oneLine.slice(0, 120) + "..." : oneLine;
    return JSON.stringify(short);
  }

  function stripMarkdownFence(value) {
    const text = cleanClipboardEdges(value);
    const m = text.match(/^```[^\n]*\n([\s\S]*?)\n?```\s*$/);
    return m ? cleanClipboardEdges(m[1]) : null;
  }

  function unwrapPayloadQuotes(value) {
    let text = cleanClipboardEdges(value);
    let changed = false;
    for (let i = 0; i < 3 && text.length >= 2; i++) {
      const first = text[0];
      const expectedLast = WRAPPER_QUOTES[first];
      if (!expectedLast || text[text.length - 1] !== expectedLast) break;
      const inner = cleanClipboardEdges(text.slice(1, -1));
      const unfenced = stripMarkdownFence(inner) || inner;
      if (!/^[\[{]/.test(cleanClipboardEdges(unfenced)) && !/^```/.test(inner)) break;
      text = inner;
      changed = true;
    }
    return changed ? text : null;
  }

  function decodeCommonHtmlEntities(value) {
    const text = cleanClipboardEdges(value);
    if (!/&(?:quot|apos|amp|lt|gt|#(?:34|39|x22|x27));/i.test(text)) return null;
    return text.replace(/&(?:quot|apos|amp|lt|gt|#(?:34|39|x22|x27));/gi, entity => {
      const key = entity.toLowerCase();
      if (key === "&quot;" || key === "&#34;" || key === "&#x22;") return '"';
      if (key === "&apos;" || key === "&#39;" || key === "&#x27;") return "'";
      if (key === "&lt;") return "<";
      if (key === "&gt;") return ">";
      return "&";
    });
  }

  function decodeLikelyUrlText(value) {
    const text = cleanClipboardEdges(value);
    const fragment = text.match(/(?:^|[?#&])(?:text|json|data|payload)=([^#&]+)/i);
    const encoded = fragment ? fragment[1] : text;
    if (!/%(?:5b|5d|7b|7d|22|27)/i.test(encoded)) return null;
    try {
      return cleanClipboardEdges(decodeURIComponent(encoded.replace(/\+/g, " ")));
    } catch {
      return null;
    }
  }

  function matchingCloser(ch) {
    return ch === "[" ? "]" : ch === "{" ? "}" : "";
  }

  function balancedJsonEnd(text, start) {
    const stack = [matchingCloser(text[start])];
    let inString = false;
    let escaped = false;
    for (let i = start + 1; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "[" || ch === "{") stack.push(matchingCloser(ch));
      else if (ch === "]" || ch === "}") {
        if (ch !== stack[stack.length - 1]) return -1;
        stack.pop();
        if (stack.length === 0) return i;
      }
    }
    return -1;
  }

  function extractFirstJsonPayload(value) {
    const text = cleanClipboardEdges(value);
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "[" && text[i] !== "{") continue;
      const end = balancedJsonEnd(text, i);
      if (end !== -1) return cleanClipboardEdges(text.slice(i, end + 1));
    }
    return null;
  }

  function singleQuotedJsonishToJson(value) {
    const text = cleanClipboardEdges(value);
    if (!text.includes("'") || !/[\[{]/.test(text)) return null;
    let out = "";
    let inDouble = false;
    let escaped = false;
    let changed = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inDouble) {
        out += ch;
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inDouble = false;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        out += ch;
        continue;
      }
      if (ch !== "'") {
        out += ch;
        continue;
      }

      let chunk = "";
      let closed = false;
      for (i = i + 1; i < text.length; i++) {
        const inner = text[i];
        if (inner === "\\") {
          const next = text[++i];
          if (next == null) return null;
          if (next === "'" || next === "\\") chunk += next;
          else if (next === "n") chunk += "\n";
          else if (next === "r") chunk += "\r";
          else if (next === "t") chunk += "\t";
          else chunk += "\\" + next;
        } else if (inner === "'") {
          closed = true;
          break;
        } else {
          chunk += inner;
        }
      }
      if (!closed) return null;
      out += JSON.stringify(chunk);
      changed = true;
    }
    return changed ? out : null;
  }

  function parseText(text) {
    const received = String(text ?? "");
    const candidates = [];
    const seen = new Set();
    const addCandidate = (value) => {
      const cleaned = cleanClipboardEdges(value);
      if (seen.has(cleaned)) return;
      seen.add(cleaned);
      candidates.push(cleaned);
    };

    addCandidate(received);
    let syntaxError = null;
    let rootError = null;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (candidate === "") {
        if (cleanClipboardEdges(received) === "") return [];
        continue;
      }

      [stripMarkdownFence, unwrapPayloadQuotes, decodeCommonHtmlEntities, decodeLikelyUrlText, extractFirstJsonPayload, singleQuotedJsonishToJson]
        .forEach(fn => {
          const next = fn(candidate);
          if (next != null) addCandidate(next);
        });

      try {
        const parsed = JSON.parse(candidate);
        if (typeof parsed === "string") {
          addCandidate(parsed);
          continue;
        }
        if (Array.isArray(parsed)) return parsed;
        rootError = new Error("JSON root must be an array of investments.");
      } catch (err) {
        if (!syntaxError) syntaxError = err;
      }
    }

    const sanitized = candidates[candidates.length - 1] || cleanClipboardEdges(received);
    const reason = rootError ? rootError.message : (syntaxError && syntaxError.message) || "invalid JSON";
    throw new Error(`couldn't parse portfolio JSON (${reason}). Received ${previewText(received)}; sanitized ${previewText(sanitized)}`);
  }

  function loadText(text) {
    loadArray(parseText(text));
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

  function amortMonths(inv) {
    return Math.max(1, Math.round(Number(inv["Amort Months"]) || 0));
  }

  function fullyAmortizingPayment(balance, monthlyRate, months) {
    if (balance <= 0 || months <= 0) return 0;
    if (Math.abs(monthlyRate) < 1e-12) return balance / months;
    const required = balance * monthlyRate / (1 - Math.pow(1 + monthlyRate, -months));
    return Number.isFinite(required) && required > 0 ? required : balance / months;
  }

  function roundCurrency(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  function inferAmortPayment(principal, annualRate, months) {
    const balance = Math.max(0, Number(principal) || 0);
    const term = Math.round(Number(months) || 0);
    if (balance <= 0 || term <= 0) return "";
    return roundCurrency(fullyAmortizingPayment(balance, (Number(annualRate) || 0) / 12, term));
  }

  function amortizedMagnitudeSchedule(balance, annualRate, months, payment, totalMonths) {
    const rm = (Number(annualRate) || 0) / 12;
    const term = Math.max(1, Math.round(Number(months) || 0));
    const scheduledPay = Math.max(Number(payment) || 0, fullyAmortizingPayment(balance, rm, term));
    const values = new Array(totalMonths + 1);
    let mag = Math.max(0, Number(balance) || 0);
    values[0] = mag;
    for (let m = 1; m <= totalMonths; m++) {
      if (m <= term && mag > 0) mag = Math.max(0, mag * (1 + rm) - scheduledPay);
      if (m >= term) mag = 0;
      values[m] = mag;
    }
    return values;
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

  function leverageLevel(debt, margin) {
    if (debt <= 0) return LEVERAGE_LEVELS[0];
    return LEVERAGE_LEVELS.find(level => margin <= level.maxMargin) || LEVERAGE_LEVELS[LEVERAGE_LEVELS.length - 1];
  }

  function leverage(taxOn) {
    const assets = assetTotal(taxOn);
    const debt = debtTotal(taxOn);
    const net = assets - debt;
    const margin = assets > 0 ? debt / assets : debt > 0 ? Infinity : 0;
    const ratio = debt > 0 && net <= 0 ? Infinity : net > 0 ? assets / net : 1;
    const level = leverageLevel(debt, margin);
    return { assets, debt, net, margin, ratio, level: level.level, threshold: level.maxMargin };
  }

  function debtWeightedRate(taxOn) {
    let weighted = 0;
    let totalWeight = 0;
    investments.filter(isDebt).forEach(inv => {
      const rate = Number(inv["Nominal Rate"]);
      if (!Number.isFinite(rate) || rate <= 0) return;
      // Debt carry is weighted by current debt magnitude so larger balances set the hero run-rate.
      const weight = presentValue(inv, taxOn);
      if (weight <= 0) return;
      weighted += weight * rate;
      totalWeight += weight;
    });
    return totalWeight > 0 ? weighted / totalWeight : 0.05;
  }

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

  /* ---------- simple aggregate projection ----------
     Aggregate assets into one line, but project each debt separately before
     summing the positive debt line. Amortized debts follow their own loan
     terms; non-amortized debts carry at the shared simple yearly rate.
     Net worth is assets - debt in the UI.
  ------------------------------------ */
  function aggregateProjection(opts) {
    const { years, rate, taxOn } = opts;
    const monthlyContribution = Math.max(0, Number(opts.monthlyContribution) || 0);
    const N = Math.max(1, Math.round(years * 12));
    const rm = (Number(rate) || 0) / 12;
    const assets = new Array(N + 1);
    const debts = new Array(N + 1);
    assets[0] = assetTotal(taxOn);
    debts.fill(0);

    investments.filter(isDebt).forEach(inv => {
      const taxMult = taxOn ? (1 - taxRate(inv)) : 1;
      const start = presentValue(inv, false);
      const values = isAmortized(inv)
        ? amortizedMagnitudeSchedule(start, inv["Nominal Rate"], amortMonths(inv), inv["Amort Payment"], N)
        : (() => {
            const carried = new Array(N + 1);
            let mag = start;
            carried[0] = mag;
            for (let m = 1; m <= N; m++) {
              mag = Math.max(0, mag * (1 + rm));
              carried[m] = mag;
            }
            return carried;
          })();
      values.forEach((v, m) => { debts[m] += v * taxMult; });
    });

    for (let m = 1; m <= N; m++) {
      assets[m] = Math.max(0, assets[m - 1] * (1 + rm) + monthlyContribution);
    }
    const months = Array.from({ length: N + 1 }, (_, m) => m);
    const debtRows = investments.filter(isDebt);
    return {
      months, assets, debts, rate: Number(rate) || 0,
      contribution: {
        monthly: monthlyContribution,
        total: monthlyContribution * N
      },
      debt: {
        amortized: debtRows.filter(isAmortized).length,
        carried: debtRows.filter(inv => !isAmortized(inv)).length
      }
    };
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
        // payment, floored at 0. The term is authoritative, so the helper uses
        // at least the fully amortizing payment and leaves no residual balance.
        const mags = amortizedMagnitudeSchedule(Math.abs(v), inv["Nominal Rate"], amortMonths(inv), inv["Amort Payment"], N);
        for (let m = 1; m <= N; m++) values[m] = -mags[m] * taxMult;
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
    FIELD_ORDER, DEFAULTS, KINDS, SUGGESTIONS, TAG_DIMENSIONS, LEVERAGE_LEVELS,
    subscribe, add, remove, update, all, loadArray, parseText, loadText, toJSON,
    presentValue, netValue, taxRate, pricePerShare, inferAmortPayment, isAmortized, isAsset, isDebt,
    total, assetTotal, debtTotal, leverage, debtWeightedRate, weightedRate, groupBy, crossTab, aggregateProjection, projection
  };
})();
