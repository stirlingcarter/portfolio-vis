/* ============================================================
   PRESENTATION LAYER — reads only from Data, never mutates
   investment fields directly. All charts are hand-rolled SVG.
   ============================================================ */

(() => {

  /* ---------- palette & formatting ---------- */

  // Muted desk-ledger palette: moss assets, aged gold, oxide debts,
  // and restrained supporting hues for categorical charts.
  const PALETTE = [
    "#7fb069", "#d6a84f", "#6ea9a3", "#b66b54", "#8f9c6c",
    "#c18f56", "#5f8f7d", "#b8896d", "#86a873", "#d0b36a",
    "#7191a6", "#a87259", "#96b07c", "#c6a15b", "#7b9c94",
    "#d28b68"
  ];
  const colorCache = {};
  let colorIdx = 0;
  function colorFor(label) {
    if (!(label in colorCache)) colorCache[label] = PALETTE[colorIdx++ % PALETTE.length];
    return colorCache[label];
  }

  // Compact, disambiguating label for a single position — same ticker in two
  // accounts reads as "QQQ (Roth)" vs "QQQ (Brk)".
  const ACCT_ABBR = {
    "Brokerage": "Brk", "Roth IRA": "Roth", "Trad IRA": "Trad", "Traditional IRA": "Trad",
    "Wallet": "Wallet", "Savings": "Sav", "Checking": "Chk", "HSA": "HSA", "401k": "401k", "Margin": "Margin"
  };
  const acctShort = a => ACCT_ABBR[a] || (a ? a.slice(0, 5) : "?");
  const positionLabel = inv => `${inv.Ticker || "#" + inv.ID} (${acctShort(inv["Account Type"])})`;

  const fmt$ = v => {
    const abs = Math.abs(v);
    if (abs >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
    if (abs >= 1e4) return "$" + (v / 1e3).toFixed(1) + "k";
    return "$" + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  };
  const fmt$full = v => "$" + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  // Full dollars-and-cents — used in the ledger where exact valuations matter.
  const fmt$cents = v => "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPct = v => (v * 100).toFixed(1) + "%";
  const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

  // Whether we should even attempt a live quote for a position. Call-signs like
  // HOUSE / DEBT / MORT and cash/loan/real-estate rows are user-valued, not
  // market-priced. A tradable symbol is 1–7 letters (optionally with . or -) and
  // isn't flagged as a debt or a non-market category.
  // Display names for tag dimensions where the stored key differs from the label
  // the user sees (Category/Subcategory keep their keys for data compatibility).
  const DIM_LABELS = { "Category": "Vehicle", "Subcategory": "Vehicle Category" };
  const dimLabel = dim => DIM_LABELS[dim] || dim;
  // Dimensions for the invested-assets donuts (Kind is omitted — all assets).
  const ASSET_DIMS = ["Institution", "Account Type", "Category", "Subcategory", "Ticker"];

  const NON_MARKET = new Set(["cash", "real estate", "loan", "mortgage", "debt"]);
  const fixedPriceForTicker = ticker => String(ticker || "").trim().toUpperCase() === "USD" ? 1 : null;
  function looksTradable(inv) {
    if (!inv || inv.Kind === "Debt") return false;
    if (NON_MARKET.has((inv.Category || "").trim().toLowerCase())) return false;
    return /^[A-Za-z][A-Za-z.\-]{0,6}$/.test((inv.Ticker || "").trim());
  }
  const shouldAutoPrice = inv => !!inv && (fixedPriceForTicker(inv.Ticker) != null || looksTradable(inv));

  /* ---------- ui state (presentation-only) ---------- */

  const ui = {
    taxOn: false,
    years: 25,
    monthly: 1000,
    projectionView: "detailed",
    simpleRate: 0.08,
    heroMetric: "net",
    biomeMode: "cards",
    contribIds: new Set(),
    contribAmounts: new Map(), // exact monthly dollars per selected position after user edits
    contribTouched: false,  // once the user picks targets, stop auto-selecting new ones
    editingId: null,        // ledger row currently being edited in place (or null)
    ledgerSort: "ID",
    ledgerSortDir: "asc",
    ledgerByInstitution: false
  };

  const UI_STORAGE_KEY = "coldledger.ui.v1";
  const RANGE_LIMITS = {
    years: { min: 1, max: 50, step: 1, fallback: 25 },
    monthly: { min: 0, max: 10000, step: 100, fallback: 1000 },
    simpleRate: { min: -0.1, max: 0.5, step: 0.005, fallback: 0.08 }
  };
  const HERO_METRICS = [
    { key: "net", label: "net worth", value: () => Data.total(ui.taxOn) },
    { key: "assets", label: "assets", value: () => Data.assetTotal(ui.taxOn) },
    { key: "debt", label: "debt", value: () => Data.debtTotal(ui.taxOn) }
  ];
  const BIOME_MODES = ["cards", "float", "pens"];
  const BIOME_MODE_META = {
    cards: {
      label: "card layout",
      note: "each holding sized by value and grown from ledger semantics",
      aria: "Terrarium card layout of portfolio holdings"
    },
    float: {
      label: "free-floating garden",
      note: "free-floating holdings · stable scatter by position",
      aria: "Free-floating terrarium visualization of portfolio holdings"
    },
    pens: {
      label: "institution pens",
      note: "holdings organized into institution pens inside the terrarium",
      aria: "Institution pens terrarium visualization of portfolio holdings"
    }
  };

  function heroMetricFor(key) {
    return HERO_METRICS.find(metric => metric.key === key) || HERO_METRICS[0];
  }

  function nextHeroMetricKey(key) {
    const idx = HERO_METRICS.findIndex(metric => metric.key === key);
    return HERO_METRICS[(idx + 1) % HERO_METRICS.length].key;
  }

  function coerceBiomeMode(value) {
    if (BIOME_MODES.includes(value)) return value;
    if (value === "free" || value === "floating") return "float";
    if (value === "institution" || value === "institutions" || value === "inst" || value === "pen") return "pens";
    return "cards";
  }

  function nextBiomeModeKey(key) {
    const mode = coerceBiomeMode(key);
    const idx = BIOME_MODES.indexOf(mode);
    return BIOME_MODES[(idx + 1) % BIOME_MODES.length];
  }

  function rangeValue(raw, spec) {
    let n = (raw === "" || raw == null || typeof raw === "boolean") ? NaN : Number(raw);
    if (!Number.isFinite(n)) n = spec.fallback;
    n = clamp(n, spec.min, spec.max);
    if (spec.step !== "any" && Number(spec.step) > 0) {
      const step = Number(spec.step);
      n = spec.min + Math.round((n - spec.min) / step) * step;
      n = clamp(n, spec.min, spec.max);
    }
    return Number(n.toFixed(6));
  }

  function readUiStorage() {
    try {
      const raw = localStorage.getItem(UI_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeUiStorage(state) {
    try { localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(state)); } catch { /* quota / privacy mode */ }
  }

  function activePortfolioId() {
    try { return Portfolios.activeId(); } catch { return null; }
  }

  function resetContributionState() {
    ui.contribTouched = false;
    ui.contribIds.clear();
    ui.contribAmounts.clear();
  }

  function serializeContributionState() {
    const amounts = {};
    ui.contribAmounts.forEach((value, id) => {
      const amount = Math.max(0, Number(value) || 0);
      amounts[String(id)] = amount;
    });
    return {
      contribTouched: ui.contribTouched,
      contribIds: [...ui.contribIds],
      contribAmounts: amounts
    };
  }

  function applyContributionState(raw) {
    resetContributionState();
    if (!raw || typeof raw !== "object") return;
    ui.contribTouched = raw.contribTouched === true;
    if (Array.isArray(raw.contribIds)) {
      raw.contribIds.forEach(id => {
        const n = Number(id);
        if (Number.isFinite(n)) ui.contribIds.add(n);
      });
    }
    if (raw.contribAmounts && typeof raw.contribAmounts === "object") {
      Object.entries(raw.contribAmounts).forEach(([id, value]) => {
        const nId = Number(id);
        const amount = Math.max(0, Number(value) || 0);
        if (Number.isFinite(nId)) ui.contribAmounts.set(nId, amount);
      });
    }
  }

  function loadStoredProjectionState() {
    const state = readUiStorage();
    const projection = state.projection;
    if (projection && typeof projection === "object") {
      if ("years" in projection) ui.years = rangeValue(projection.years, RANGE_LIMITS.years);
      if ("monthly" in projection) ui.monthly = rangeValue(projection.monthly, RANGE_LIMITS.monthly);
      if ("taxOn" in projection) ui.taxOn = projection.taxOn === true;
      if ("projectionView" in projection) ui.projectionView = projection.projectionView === "simple" ? "simple" : "detailed";
      if ("simpleRate" in projection) ui.simpleRate = rangeValue(projection.simpleRate, RANGE_LIMITS.simpleRate);
    }
    if ("heroMetric" in state) ui.heroMetric = heroMetricFor(state.heroMetric).key;
    if ("biomeMode" in state) ui.biomeMode = coerceBiomeMode(state.biomeMode);
  }

  function loadActiveContributionState() {
    const state = readUiStorage();
    const activeId = activePortfolioId();
    const byPortfolio = state.portfolios && typeof state.portfolios === "object" ? state.portfolios : {};
    applyContributionState(activeId ? byPortfolio[activeId] : null);
  }

  function saveUiState() {
    const state = readUiStorage();
    const next = {
      version: 1,
      projection: {
        years: rangeValue(ui.years, RANGE_LIMITS.years),
        monthly: rangeValue(ui.monthly, RANGE_LIMITS.monthly),
        taxOn: ui.taxOn === true,
        projectionView: ui.projectionView === "simple" ? "simple" : "detailed",
        simpleRate: rangeValue(ui.simpleRate, RANGE_LIMITS.simpleRate)
      },
      heroMetric: heroMetricFor(ui.heroMetric).key,
      biomeMode: coerceBiomeMode(ui.biomeMode),
      portfolios: state.portfolios && typeof state.portfolios === "object" ? { ...state.portfolios } : {}
    };
    const activeId = activePortfolioId();
    if (activeId) next.portfolios[activeId] = serializeContributionState();
    writeUiStorage(next);
  }

  function syncProjectionControlsToDom() {
    const years = $("#years-slider"), monthly = $("#monthly-slider"), simpleRate = $("#simple-rate-slider");
    if (years) {
      years.min = String(RANGE_LIMITS.years.min);
      years.max = String(RANGE_LIMITS.years.max);
      years.step = String(RANGE_LIMITS.years.step);
      ui.years = rangeValue(ui.years, RANGE_LIMITS.years);
      years.value = String(ui.years);
      const out = $("#years-out");
      if (out) out.textContent = ui.years + " yrs";
    }
    if (monthly) {
      monthly.min = String(RANGE_LIMITS.monthly.min);
      monthly.max = String(RANGE_LIMITS.monthly.max);
      monthly.step = String(RANGE_LIMITS.monthly.step);
      ui.monthly = rangeValue(ui.monthly, RANGE_LIMITS.monthly);
      monthly.value = String(ui.monthly);
      const out = $("#monthly-out");
      if (out) out.textContent = fmt$full(ui.monthly) + "/mo";
    }
    if (simpleRate) {
      simpleRate.min = String(RANGE_LIMITS.simpleRate.min * 100);
      simpleRate.max = String(RANGE_LIMITS.simpleRate.max * 100);
      simpleRate.step = String(RANGE_LIMITS.simpleRate.step * 100);
      ui.simpleRate = rangeValue(ui.simpleRate, RANGE_LIMITS.simpleRate);
      simpleRate.value = String(+(ui.simpleRate * 100).toFixed(3));
      const out = $("#simple-rate-out");
      if (out) out.textContent = fmtPct(ui.simpleRate) + "/yr";
    }
    document.querySelectorAll(".tax-toggle").forEach(t => { t.checked = ui.taxOn; });
    syncProjectionModeToDom();
    syncBiomeModeToDom();
  }

  function syncProjectionModeToDom() {
    const simple = ui.projectionView === "simple";
    const section = $("#projection");
    if (section) section.classList.toggle("is-simple", simple);
    const detailedBtn = $("#proj-view-detailed");
    const simpleBtn = $("#proj-view-simple");
    if (detailedBtn) detailedBtn.setAttribute("aria-pressed", String(!simple));
    if (simpleBtn) simpleBtn.setAttribute("aria-pressed", String(simple));
    const note = $("#projection-mode-note");
    if (note) note.textContent = simple
      ? "aggregate assets · scheduled debt paydown"
      : "one layer per position · hover for detail";
  }

  function syncBiomeModeToDom() {
    ui.biomeMode = coerceBiomeMode(ui.biomeMode);
    const mode = ui.biomeMode;
    const meta = BIOME_MODE_META[mode];
    const nextMeta = BIOME_MODE_META[nextBiomeModeKey(mode)];
    const whistle = $("#biome-whistle");
    if (whistle) {
      whistle.dataset.mode = mode;
      whistle.setAttribute("aria-pressed", String(mode !== "cards"));
      whistle.title = `${meta.label} · switch to ${nextMeta.label}`;
      whistle.setAttribute("aria-label", `Terrarium layout: ${meta.label}. Activate to switch to ${nextMeta.label}.`);
    }
    const note = $("#biome-mode-note");
    if (note) note.textContent = meta.note;
  }

  const $ = sel => document.querySelector(sel);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const svgEl = (tag, attrs) => {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  /* ---------- tooltip & toast ---------- */

  const tooltip = $("#tooltip");
  function showTip(html, x, y) {
    tooltip.innerHTML = html;
    tooltip.style.opacity = 1;
    const pad = 14;
    const w = tooltip.offsetWidth, h = tooltip.offsetHeight;
    tooltip.style.left = Math.min(x + pad, window.innerWidth - w - 8) + "px";
    tooltip.style.top = Math.max(y - h - pad, 8) + "px";
  }
  function hideTip() { tooltip.style.opacity = 0; }

  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
  }

  /* ---------- donut chart ---------- */

  function donut(container, title, groups, totalLabel) {
    const card = el("div", "panel donut-card");
    card.appendChild(el("h3", null, title));
    const body = el("div", "donut-body");

    const size = 150, cx = size / 2, cy = size / 2, rOut = 70, rIn = 46;
    const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, class: "donut-svg", width: size, height: size, role: "img" });
    const total = groups.reduce((s, g) => s + g.value, 0) || 1;

    const polar = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    let angle = -Math.PI / 2;
    groups.forEach(g => {
      const frac = g.value / total;
      const sweep = Math.max(frac * Math.PI * 2 - 0.03, 0.005);
      const a0 = angle + 0.015, a1 = angle + 0.015 + sweep;
      angle += frac * Math.PI * 2;
      const large = sweep > Math.PI ? 1 : 0;
      const [x0o, y0o] = polar(rOut, a0), [x1o, y1o] = polar(rOut, a1);
      const [x0i, y0i] = polar(rIn, a1), [x1i, y1i] = polar(rIn, a0);
      const path = svgEl("path", {
        d: `M ${x0o} ${y0o} A ${rOut} ${rOut} 0 ${large} 1 ${x1o} ${y1o} L ${x0i} ${y0i} A ${rIn} ${rIn} 0 ${large} 0 ${x1i} ${y1i} Z`,
        fill: colorFor(g.label), class: "donut-seg"
      });
      path.addEventListener("mousemove", e =>
        showTip(`<b>${g.label}</b><br><span class="tt-k">value</span> ${fmt$full(g.value)}<br><span class="tt-k">share</span> ${fmtPct(g.value / total)} · ${g.count} position${g.count > 1 ? "s" : ""}`, e.clientX, e.clientY));
      path.addEventListener("mouseleave", hideTip);
      svg.appendChild(path);
    });

    const centerNum = svgEl("text", { x: cx, y: cy, "text-anchor": "middle", class: "donut-center-num" });
    centerNum.textContent = fmt$(total === 1 && groups.length === 0 ? 0 : total);
    const centerLbl = svgEl("text", { x: cx, y: cy + 14, "text-anchor": "middle", class: "donut-center-lbl" });
    centerLbl.textContent = totalLabel;
    svg.appendChild(centerNum); svg.appendChild(centerLbl);
    body.appendChild(svg);

    const legend = el("div", "legend");
    groups.slice(0, 8).forEach(g => {
      const row = el("div", "legend-row");
      const sw = el("span", "swatch"); sw.style.background = colorFor(g.label);
      row.appendChild(sw);
      row.appendChild(el("span", "lbl", g.label));
      row.appendChild(el("span", "pct", fmtPct(g.value / total)));
      legend.appendChild(row);
    });
    if (groups.length > 8) legend.appendChild(el("div", "legend-row", `<span class="lbl" style="color:var(--faint)">+ ${groups.length - 8} more</span>`));
    body.appendChild(legend);
    card.appendChild(body);
    container.appendChild(card);
  }

  /* ---------- stacked area projection (signature chart) ---------- */

  const niceMax = v => { if (v <= 0) return 0; const m = Math.pow(10, Math.floor(Math.log10(v))); return Math.ceil(v / (m / 2)) * (m / 2); };

  function stackedArea(container, proj) {
    container.innerHTML = "";
    const W = 1080, H = 440, padL = 76, padR = 24, padT = 24, padB = 40;
    const iw = W - padL - padR, ih = H - padT - padB;
    const N = proj.months.length - 1;

    // Chart composition shows balances as comparable magnitudes: assets use
    // their projected value, while debts use abs(value). Net worth remains signed.
    const assets = proj.series.filter(s => !s.isDebt);
    const debts = proj.series.filter(s => s.isDebt);
    const chartValue = (s, v) => s.isDebt ? Math.abs(v) : v;
    const positiveTop = new Array(N + 1).fill(0);
    const negativeBot = new Array(N + 1).fill(0);
    proj.series.forEach(s => s.values.forEach((v, m) => {
      const cv = chartValue(s, v);
      if (cv >= 0) positiveTop[m] += cv;
      else negativeBot[m] += cv;
    }));

    const yMax = Math.max(niceMax(Math.max(...positiveTop, 1)), 1);
    // Only actual negative assets/projected values expand the chart below zero.
    // Debt magnitude is shown above zero, and negative net worth is called out
    // with a clipped line/label instead of making the whole chart go negative.
    const yMin = Math.min(...negativeBot, 0) < 0 ? -niceMax(-Math.min(...negativeBot, 0)) : 0;

    const x = m => padL + (m / N) * iw;
    const y = v => padT + ih - ((v - yMin) / (yMax - yMin)) * ih;
    const yClamped = v => y(Math.min(Math.max(v, yMin), yMax));

    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img", "aria-label": "Projected balances and net worth over time" });

    // grid + y labels across the full domain
    for (let i = 0; i <= 4; i++) {
      const v = yMin + ((yMax - yMin) / 4) * i;
      svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: "grid-line" }));
      const t = svgEl("text", { x: padL - 10, y: y(v) + 4, "text-anchor": "end", class: "axis-text" });
      t.textContent = fmt$(v);
      svg.appendChild(t);
    }
    // Emphasize zero only when actual position values extend below it.
    if (yMin < 0) {
      const zy = y(0);
      svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: zy, y2: zy, class: "zero-line" }));
      const z = svgEl("text", { x: padL - 10, y: zy + 4, "text-anchor": "end", class: "axis-text zero-axis-text" });
      z.textContent = "$0";
      svg.appendChild(z);
    }

    const yearStep = ui.years > 30 ? 10 : ui.years > 12 ? 5 : ui.years > 5 ? 2 : 1;
    for (let yr = 0; yr <= ui.years; yr += yearStep) {
      const t = svgEl("text", { x: x(yr * 12), y: H - 10, "text-anchor": "middle", class: "axis-text" });
      t.textContent = yr === 0 ? "now" : "+" + yr + "y";
      svg.appendChild(t);
    }

    const step = Math.max(1, Math.floor(N / 240));
    // Draw one stacked band, from a running baseline out to baseline+value.
    const drawBand = (s, base, values) => {
      const top = values.map((v, m) => base[m] + v);
      let d = "";
      for (let m = 0; m <= N; m += step) d += (m === 0 ? "M" : "L") + x(m).toFixed(1) + " " + y(top[m]).toFixed(1) + " ";
      d += "L" + x(N).toFixed(1) + " " + y(top[N]).toFixed(1) + " ";
      for (let m = N; m >= 0; m -= step) d += "L" + x(m).toFixed(1) + " " + y(base[m]).toFixed(1) + " ";
      d += "L" + x(0).toFixed(1) + " " + y(base[0]).toFixed(1) + " Z";
      const c = colorFor(s.label);
      const attrs = {
        d, fill: c,
        "fill-opacity": s.contributing ? 0.5 : 0.28,          // contributing layers pop
        stroke: c, "stroke-opacity": 0.9,
        "stroke-width": s.contributing ? 2.2 : 1.2
      };
      if (s.amortized) attrs["stroke-dasharray"] = "5 4";      // amortizing debt = dashed
      svg.appendChild(svgEl("path", attrs));
      return top;
    };

    // Positive magnitudes: assets first, then debt balances above them for comparison.
    let base = new Array(N + 1).fill(0);
    assets.slice().sort((a, b) => b.values[0] - a.values[0]).forEach(s => {
      base = drawBand(s, base, s.values.map(v => Math.max(v, 0)));
    });
    debts.slice().sort((a, b) => Math.abs(b.values[0]) - Math.abs(a.values[0])).forEach(s => {
      base = drawBand(s, base, s.values.map(v => Math.abs(v)));
    });
    // Rare case: an asset itself projects below zero. Only then draw below zero.
    let negBase = new Array(N + 1).fill(0);
    assets.filter(s => s.values.some(v => v < 0)).forEach(s => {
      negBase = drawBand(s, negBase, s.values.map(v => Math.min(v, 0)));
    });

    // Net worth line on top, highlighted separately from the position layers.
    let nd = "";
    for (let m = 0; m <= N; m += step) nd += (m === 0 ? "M" : "L") + x(m).toFixed(1) + " " + yClamped(proj.totals[m]).toFixed(1) + " ";
    svg.appendChild(svgEl("path", { d: nd, fill: "none", class: "net-worth-halo" }));
    svg.appendChild(svgEl("path", { d: nd, fill: "none", class: "net-worth-line" }));
    const netEnd = proj.totals[N];
    const netEndY = Math.min(Math.max(yClamped(netEnd), padT + 16), padT + ih - 8);
    svg.appendChild(svgEl("circle", { cx: x(N), cy: yClamped(netEnd), r: 3.5, class: "net-worth-dot" }));
    const netLabel = svgEl("text", { x: W - padR - 8, y: netEndY - 8, "text-anchor": "end", class: "net-worth-label" });
    netLabel.textContent = `Net worth ${fmt$(netEnd)}${netEnd < yMin ? " (below $0)" : ""}`;
    svg.appendChild(netLabel);

    // crosshair
    const cross = svgEl("line", { x1: 0, x2: 0, y1: padT, y2: padT + ih, class: "crosshair-line", opacity: 0 });
    svg.appendChild(cross);

    const ordered = proj.series.slice().sort((a, b) => Math.abs(b.values[0]) - Math.abs(a.values[0]));
    svg.addEventListener("mousemove", e => {
      const rect = svg.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width * W;
      const m = Math.round(Math.min(Math.max((mx - padL) / iw, 0), 1) * N);
      cross.setAttribute("x1", x(m)); cross.setAttribute("x2", x(m));
      cross.setAttribute("opacity", 1);
      const yrs = (m / 12).toFixed(1);
      const rows = ordered.slice(0, 7).map(s => {
        const mark = s.contributing ? `<span class="tt-mark">＋</span>` : s.amortized ? `<span class="tt-mark">↓</span>` : "";
        const value = s.isDebt ? Math.abs(s.values[m]) : s.values[m];
        return `${mark}<span class="tt-k">${s.label}</span> ${fmt$(value)}${s.isDebt ? " owed" : ""}`;
      }).join("<br>");
      showTip(`<b>+${yrs} yrs · net ${fmt$full(proj.totals[m])}</b><br>${rows}${ordered.length > 7 ? "<br><span class='tt-k'>…</span>" : ""}<br><span class="tt-k" style="opacity:.7">debts plotted as positive balances · ＋ receiving contributions · ↓ amortizing</span>`, e.clientX, e.clientY);
    });
    svg.addEventListener("mouseleave", () => { cross.setAttribute("opacity", 0); hideTip(); });

    container.appendChild(svg);
  }

  function aggregateLineChart(container, proj) {
    container.innerHTML = "";
    const W = 1080, H = 420, padL = 76, padR = 34, padT = 28, padB = 44;
    const iw = W - padL - padR, ih = H - padT - padB;
    const N = proj.months.length - 1;
    const allValues = proj.assets.concat(proj.debts);
    const yMax = Math.max(niceMax(Math.max(...allValues, 1)), 1);
    const x = m => padL + (m / N) * iw;
    const y = v => padT + ih - (v / yMax) * ih;
    const step = Math.max(1, Math.floor(N / 240));

    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg aggregate-chart-svg", role: "img", "aria-label": "Aggregate assets and debt balances over time" });
    for (let i = 0; i <= 4; i++) {
      const v = (yMax / 4) * i;
      svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: "grid-line" }));
      const t = svgEl("text", { x: padL - 10, y: y(v) + 4, "text-anchor": "end", class: "axis-text" });
      t.textContent = fmt$(v);
      svg.appendChild(t);
    }

    const yearStep = ui.years > 30 ? 10 : ui.years > 12 ? 5 : ui.years > 5 ? 2 : 1;
    for (let yr = 0; yr <= ui.years; yr += yearStep) {
      const t = svgEl("text", { x: x(yr * 12), y: H - 12, "text-anchor": "middle", class: "axis-text" });
      t.textContent = yr === 0 ? "now" : "+" + yr + "y";
      svg.appendChild(t);
    }

    const pathFor = values => {
      let d = "";
      for (let m = 0; m <= N; m += step) d += (m === 0 ? "M" : "L") + x(m).toFixed(1) + " " + y(values[m]).toFixed(1) + " ";
      if ((N % step) !== 0) d += "L" + x(N).toFixed(1) + " " + y(values[N]).toFixed(1) + " ";
      return d;
    };
    svg.appendChild(svgEl("path", { d: pathFor(proj.assets), fill: "none", class: "aggregate-line aggregate-assets-line" }));
    svg.appendChild(svgEl("path", { d: pathFor(proj.debts), fill: "none", class: "aggregate-line aggregate-debt-line" }));

    const endAssets = proj.assets[N];
    const endDebts = proj.debts[N];
    [
      { label: "Assets", value: endAssets, cls: "aggregate-assets-label" },
      { label: "Debt", value: endDebts, cls: "aggregate-debt-label" }
    ].forEach(item => {
      svg.appendChild(svgEl("circle", { cx: x(N), cy: y(item.value), r: 4, class: item.cls }));
      const label = svgEl("text", { x: W - padR - 6, y: y(item.value) - 9, "text-anchor": "end", class: `aggregate-end-label ${item.cls}` });
      label.textContent = `${item.label} ${fmt$(item.value)}`;
      svg.appendChild(label);
    });

    const legend = svgEl("g", { class: "aggregate-legend" });
    [
      { x: padL, color: "assets", text: "Assets" },
      { x: padL + 120, color: "debt", text: "Debt" }
    ].forEach(item => {
      legend.appendChild(svgEl("line", { x1: item.x, x2: item.x + 26, y1: padT - 8, y2: padT - 8, class: `aggregate-legend-line ${item.color}` }));
      const text = svgEl("text", { x: item.x + 34, y: padT - 4, class: "axis-text" });
      text.textContent = item.text;
      legend.appendChild(text);
    });
    svg.appendChild(legend);

    const cross = svgEl("line", { x1: 0, x2: 0, y1: padT, y2: padT + ih, class: "crosshair-line", opacity: 0 });
    svg.appendChild(cross);
    svg.addEventListener("mousemove", e => {
      const rect = svg.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width * W;
      const m = Math.round(Math.min(Math.max((mx - padL) / iw, 0), 1) * N);
      cross.setAttribute("x1", x(m)); cross.setAttribute("x2", x(m));
      cross.setAttribute("opacity", 1);
      const net = proj.assets[m] - proj.debts[m];
      showTip(`<b>+${(m / 12).toFixed(1)} yrs · ${fmtPct(proj.rate)}/yr</b><br><span class="tt-k">Assets</span> ${fmt$full(proj.assets[m])}<br><span class="tt-k">Debt</span> ${fmt$full(proj.debts[m])}<br><span class="tt-k">Net</span> ${fmt$full(net)}<br><span class="tt-k" style="opacity:.7">debt plotted as positive balance</span>`, e.clientX, e.clientY);
    });
    svg.addEventListener("mouseleave", () => { cross.setAttribute("opacity", 0); hideTip(); });

    container.appendChild(svg);
  }

  /* ---------- horizontal bars ---------- */

  function hBars(container, groups) {
    container.innerHTML = "";
    const max = Math.max(...groups.map(g => g.value), 1);
    groups.forEach(g => {
      const row = el("div", "bar-row");
      row.appendChild(el("span", "b-lbl", g.label));
      const track = el("div", "bar-track");
      const fill = el("div", "bar-fill");
      fill.style.width = (g.value / max * 100).toFixed(1) + "%";
      fill.style.background = colorFor(g.label);
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el("span", "b-val", fmt$(g.value)));
      container.appendChild(row);
    });
    if (groups.length === 0) container.appendChild(el("div", "file-note", "No positions yet."));
  }

  /* ---------- crosstab stacked bars ---------- */

  function stackBars(container, xtab) {
    container.innerHTML = "";
    const rowTotals = xtab.rows.map(r => Object.values(xtab.cells[r]).reduce((s, v) => s + v, 0));
    xtab.rows.forEach((r, i) => {
      const wrap = el("div", "stackbar-row");
      const head = el("div", "stackbar-head");
      head.appendChild(el("span", "r-lbl", r));
      head.appendChild(el("span", null, fmt$(rowTotals[i])));
      wrap.appendChild(head);
      const bar = el("div", "stackbar");
      xtab.cols.forEach(c => {
        const v = xtab.cells[r][c] || 0;
        if (v <= 0) return;
        const seg = el("div");
        seg.style.width = (v / rowTotals[i] * 100) + "%";
        seg.style.background = colorFor(c);
        seg.addEventListener("mousemove", e =>
          showTip(`<b>${c}</b> in ${r}<br>${fmt$full(v)} · ${fmtPct(v / rowTotals[i])}`, e.clientX, e.clientY));
        seg.addEventListener("mouseleave", hideTip);
        bar.appendChild(seg);
      });
      wrap.appendChild(bar);
      container.appendChild(wrap);
    });
    if (xtab.rows.length === 0) container.appendChild(el("div", "file-note", "No positions yet."));
  }

  /* ---------- spatial 2026 visualizations ---------- */

  const cleanTag = v => String(v || "—").trim() || "—";
  const invMagnitude = inv => Data.presentValue(inv, ui.taxOn);
  const terrariumCategory = inv => cleanTag(inv.Category).toLowerCase();
  const terrariumSubcategory = inv => cleanTag(inv.Subcategory).toLowerCase();
  const terrariumTicker = inv => cleanTag(inv.Ticker).toUpperCase();
  const CRYPTO_TICKERS = new Set(["BTC", "ETH", "SOL", "ADA", "DOGE", "DOT", "LINK", "AVAX", "MATIC", "LTC", "BCH", "XRP"]);
  const isCryptoLike = inv => {
    const category = terrariumCategory(inv);
    const subcategory = terrariumSubcategory(inv);
    const ticker = terrariumTicker(inv);
    return inv.Kind !== "Debt" && (
      category.includes("crypto") || category.includes("coin") ||
      subcategory.includes("crypto") || subcategory.includes("coin") ||
      CRYPTO_TICKERS.has(ticker)
    );
  };
  const isCashLike = inv => {
    const category = terrariumCategory(inv);
    const subcategory = terrariumSubcategory(inv);
    const ticker = terrariumTicker(inv);
    return inv.Kind !== "Debt" && (
      category.includes("cash") || subcategory.includes("cash") || ticker === "USD"
    );
  };
  const isGoldLike = inv => {
    return isCryptoLike(inv) || isCashLike(inv);
  };
  const terrariumColorFor = inv => {
    if (inv.Kind === "Debt") return "var(--danger)";
    if (isGoldLike(inv)) return "var(--coin)";
    return "var(--asset)";
  };
  const shapeFor = inv => {
    const category = terrariumCategory(inv);
    if (inv.Kind === "Debt") return "debt";
    if (isGoldLike(inv)) return "nugget";
    if (category.includes("bond")) return "crystal";
    if (category.includes("real") || category.includes("stock") || category.includes("fund")) return "plant";
    return "vehicle";
  };
  const stableUnit = (seed, salt) => {
    const n = Number(seed) || 0;
    const x = Math.sin((n + 1) * 12.9898 + salt * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const FLOAT_STAGE = { w: 1000, h: 620 };
  const floatSizeFor = (value, max) => clamp(56 + Math.sqrt(value / max) * 88, 56, 144);
  const cardEntitySizeFor = (value, max) => clamp(66 + Math.sqrt(value / max) * 96, 66, 162);
  const penEntitySizeFor = (value, max) => clamp(50 + Math.sqrt(value / max) * 62, 50, 112);
  function floatLayoutFor(invs, max) {
    const count = Math.max(invs.length, 1);
    const cols = Math.ceil(Math.sqrt(count * 1.55));
    const rows = Math.ceil(count / cols);
    const slots = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = ((col + .5) / cols) * FLOAT_STAGE.w;
        const y = ((row + .5) / rows) * FLOAT_STAGE.h;
        slots.push({ x, y, score: Math.hypot(x - FLOAT_STAGE.w / 2, y - FLOAT_STAGE.h / 2) });
      }
    }
    slots.sort((a, b) => a.score - b.score);

    const nodes = invs.map((inv, idx) => {
      const value = invMagnitude(inv);
      const size = floatSizeFor(value, max);
      const slot = slots[idx] || slots[slots.length - 1];
      const jitterX = (stableUnit(inv.ID, 1) - .5) * Math.min(70, FLOAT_STAGE.w / (cols * 3));
      const jitterY = (stableUnit(inv.ID, 2) - .5) * Math.min(52, FLOAT_STAGE.h / (rows * 3));
      const radius = Math.max(38, size * .42);
      return {
        inv,
        size,
        radius,
        x: clamp(slot.x + jitterX, radius, FLOAT_STAGE.w - radius),
        y: clamp(slot.y + jitterY, radius, FLOAT_STAGE.h - radius),
        rot: -7 + stableUnit(inv.ID, 3) * 14,
        delay: -stableUnit(inv.ID, 4) * 5
      };
    });

    for (let pass = 0; pass < 72; pass++) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let dist = Math.hypot(dx, dy);
          if (dist < .001) {
            dx = stableUnit(a.inv.ID, j + 7) - .5;
            dy = stableUnit(b.inv.ID, i + 11) - .5;
            dist = Math.hypot(dx, dy) || 1;
          }
          const minDist = a.radius + b.radius + 12;
          if (dist >= minDist) continue;
          const push = (minDist - dist) * .5;
          const nx = dx / dist;
          const ny = dy / dist;
          a.x -= nx * push;
          a.y -= ny * push;
          b.x += nx * push;
          b.y += ny * push;
        }
      }
      nodes.forEach(n => {
        n.x = clamp(n.x, n.radius, FLOAT_STAGE.w - n.radius);
        n.y = clamp(n.y, n.radius * .8, FLOAT_STAGE.h - n.radius * .75);
      });
    }

    return new Map(nodes.map(n => [n.inv.ID, {
      size: n.size,
      x: (n.x / FLOAT_STAGE.w) * 100,
      y: (n.y / FLOAT_STAGE.h) * 100,
      rot: n.rot,
      delay: n.delay
    }]));
  }

  function renderHeroExperience(proj) {
    const metrics = $("#hero-metrics");
    const stage = $("#hero-visual");
    if (!metrics || !stage) return;

    const invs = Data.all();
    const assets = Data.assetTotal(ui.taxOn);
    const debts = Data.debtTotal(ui.taxOn);
    const end = proj.totals[proj.totals.length - 1];
    const gain = end - Data.total(ui.taxOn);
    metrics.innerHTML = `
      <span class="hero-chip"><b>${fmt$full(assets)}</b> gross assets</span>
      <span class="hero-chip"><b>${fmt$full(debts)}</b> debts</span>
      <span class="hero-chip"><b>${fmt$(Math.max(gain, 0))}</b> projected growth</span>
      <span class="hero-chip"><b>${fmtPct(Data.weightedRate())}</b> blended real rate</span>`;

    stage.innerHTML = "";
    const orbit = el("div", "hero-orbit");
    [
      { inset: "7%", rot: "8deg" },
      { inset: "18%", rot: "-28deg" },
      { inset: "29%", rot: "42deg" }
    ].forEach(r => {
      const ring = el("span", "hero-ring");
      ring.style.setProperty("--inset", r.inset);
      ring.style.setProperty("--rot", r.rot);
      orbit.appendChild(ring);
    });

    const heroMetric = heroMetricFor(ui.heroMetric);
    const heroMetricValue = heroMetric.value();
    const nextHeroMetric = heroMetricFor(nextHeroMetricKey(heroMetric.key));
    const taxContext = ui.taxOn ? " · post-tax" : "";
    const core = el("button", "hero-core", `<b>${fmt$(heroMetricValue)}</b><span>${heroMetric.label}${taxContext}</span>`);
    core.type = "button";
    core.title = `Show ${nextHeroMetric.label}`;
    core.setAttribute("aria-label", `Showing ${heroMetric.label}: ${fmt$full(heroMetricValue)}${ui.taxOn ? " post-tax" : ""}. Activate to show ${nextHeroMetric.label}.`);
    core.addEventListener("click", () => {
      ui.heroMetric = nextHeroMetricKey(ui.heroMetric);
      saveUiState();
      renderAll();
    });
    orbit.appendChild(core);

    const max = Math.max(...invs.map(invMagnitude), 1);
    invs.slice().sort((a, b) => invMagnitude(b) - invMagnitude(a)).slice(0, 18).forEach((inv, i, arr) => {
      const n = el("span", `orbit-node${inv.Kind === "Debt" ? " debt" : ""}`);
      const value = invMagnitude(inv);
      const angle = (i / Math.max(arr.length, 1)) * 360 + (i % 2 ? 10 : -5);
      const dist = 132 + (i % 3) * 32;
      const size = clamp(12 + Math.sqrt(value / max) * 34, 12, 46);
      n.style.setProperty("--angle", angle + "deg");
      n.style.setProperty("--dist", dist + "px");
      n.style.setProperty("--size", size + "px");
      n.style.setProperty("--c", colorFor(inv.Category || inv.Ticker));
      n.title = `${positionLabel(inv)} · ${fmt$full(value)}${inv.Kind === "Debt" ? " owed" : ""}`;
      orbit.appendChild(n);
    });
    stage.appendChild(orbit);
  }

  function entityMarkup(shape) {
    if (shape === "debt") return `<div class="entity debt"><span class="stone"></span></div>`;
    if (shape === "nugget") return `<div class="entity nugget"><span class="nugget-body"></span><span class="nugget-shine"></span></div>`;
    if (shape === "crystal") return `<div class="entity crystal"><span class="facet"></span></div>`;
    if (shape === "vehicle") {
      return `<div class="entity vehicle"><span class="body"></span><span class="cab"></span><span class="wheel a"></span><span class="wheel b"></span></div>`;
    }
    return `<div class="entity plant"><span class="stem"></span><span class="leaf a"></span><span class="leaf b"></span><span class="leaf c"></span></div>`;
  }

  function wireFloatDrag(card, wrap) {
    card.classList.add("is-draggable");
    card.addEventListener("pointerdown", e => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      const bounds = wrap.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      e.preventDefault();
      card.focus({ preventScroll: true });
      card.setPointerCapture(e.pointerId);
      card.classList.add("is-dragging");
      hideTip();

      const start = {
        clientX: e.clientX,
        clientY: e.clientY,
        x: parseFloat(card.style.getPropertyValue("--float-x")) || 50,
        y: parseFloat(card.style.getPropertyValue("--float-y")) || 50,
        size: parseFloat(card.style.getPropertyValue("--float-size")) || 120
      };
      const edgeX = clamp((start.size * .48 / bounds.width) * 100, 5, 18);
      const edgeY = clamp((start.size * .58 / bounds.height) * 100, 8, 24);

      const move = moveEvent => {
        const nextX = start.x + ((moveEvent.clientX - start.clientX) / bounds.width) * 100;
        const nextY = start.y + ((moveEvent.clientY - start.clientY) / bounds.height) * 100;
        card.style.setProperty("--float-x", clamp(nextX, edgeX, 100 - edgeX).toFixed(2) + "%");
        card.style.setProperty("--float-y", clamp(nextY, edgeY, 100 - edgeY).toFixed(2) + "%");
      };
      const stop = stopEvent => {
        card.classList.remove("is-dragging");
        if (card.hasPointerCapture(stopEvent.pointerId)) card.releasePointerCapture(stopEvent.pointerId);
        card.removeEventListener("pointermove", move);
        card.removeEventListener("pointerup", stop);
        card.removeEventListener("pointercancel", stop);
      };

      card.addEventListener("pointermove", move);
      card.addEventListener("pointerup", stop);
      card.addEventListener("pointercancel", stop);
    });
  }

  function createBiomeEntityCard(inv, idx, max, mode, opts = {}) {
    const floating = mode === "float";
    const penned = mode === "pens";
    const value = invMagnitude(inv);
    const color = terrariumColorFor(inv);
    const shape = shapeFor(inv);
    const card = el("div", [
      "entity-card",
      floating ? "float-card" : "",
      penned ? "pen-card" : ""
    ].filter(Boolean).join(" "));
    card.tabIndex = 0;
    card.setAttribute("role", "img");
    card.setAttribute("aria-label", `${positionLabel(inv)}, ${cleanTag(inv.Category)}, ${fmt$full(value)}${inv.Kind === "Debt" ? " owed" : ""}, shown as ${shape}`);
    card.style.setProperty("--entity-color", color);
    card.style.setProperty("--tilt", (idx % 2 ? "-4deg" : "4deg"));
    if (floating) {
      const floatLayout = opts.floatLayout || new Map();
      const pos = floatLayout.get(inv.ID) || {
        size: floatSizeFor(value, max),
        x: 50,
        y: 50,
        rot: 0,
        delay: 0
      };
      card.style.setProperty("--float-size", pos.size + "px");
      card.style.setProperty("--float-x", pos.x.toFixed(2) + "%");
      card.style.setProperty("--float-y", pos.y.toFixed(2) + "%");
      card.style.setProperty("--float-rot", pos.rot.toFixed(2) + "deg");
      card.style.setProperty("--float-delay", pos.delay.toFixed(2) + "s");
      card.title = "Drag with a mouse to reposition until the view re-renders.";
    }
    card.innerHTML = `
      <div class="entity-card-lift">
        ${entityMarkup(shape)}
        <div class="entity-ground"></div>
        <div class="entity-label"><b>${inv.Ticker || "—"}</b><span>${fmt$(value)} · ${penned ? cleanTag(inv["Account Type"]) : cleanTag(inv.Category)}</span></div>
      </div>`;
    card.querySelector(".entity").style.setProperty("--h", floating
      ? "var(--float-size)"
      : (penned ? penEntitySizeFor(value, max) : cardEntitySizeFor(value, max)) + "px");
    card.addEventListener("pointerenter", () => card.classList.add("is-hovered"));
    card.addEventListener("mousemove", e => {
      if (card.classList.contains("is-dragging")) return;
      showTip(`<b>${positionLabel(inv)}</b><br><span class="tt-k">${cleanTag(inv.Institution)} · ${cleanTag(inv["Account Type"])}</span><br>${fmt$full(value)}${inv.Kind === "Debt" ? " owed" : ""}<br><span class="tt-k">growth</span> ${fmtPct(inv["Nominal Rate"])}`, e.clientX, e.clientY);
    });
    const clearHover = () => {
      card.classList.remove("is-hovered");
      hideTip();
    };
    card.addEventListener("pointerleave", clearHover);
    card.addEventListener("pointercancel", clearHover);
    card.addEventListener("focus", () => {
      card.classList.add("is-focused");
      const r = card.getBoundingClientRect();
      showTip(`<b>${positionLabel(inv)}</b><br>${fmt$full(value)} · ${cleanTag(inv.Category)}<br><span class="tt-k">growth</span> ${fmtPct(inv["Nominal Rate"])}`, r.left + r.width / 2, r.top);
    });
    card.addEventListener("blur", () => {
      card.classList.remove("is-focused");
      hideTip();
    });
    if (floating && opts.wrap) wireFloatDrag(card, opts.wrap);
    return card;
  }

  function renderBiomePens(wrap, invs, max, totalCount) {
    const groups = institutionGroups(invs);
    groups.forEach(inst => {
      const pen = el("section", "institution-pen");
      pen.setAttribute("aria-label", `${inst.name} pen, ${fmt$full(inst.value)}, ${inst.count} position${inst.count === 1 ? "" : "s"}`);
      const head = el("div", "institution-pen-head");
      head.appendChild(el("h3", null, inst.name));
      head.appendChild(el("span", null, `${fmt$(inst.value)} · ${inst.count} pos`));
      pen.appendChild(head);
      const yard = el("div", "institution-pen-yard");
      inst.holdings.forEach((inv, holdingIdx) => {
        yard.appendChild(createBiomeEntityCard(inv, inst.idx * 100 + holdingIdx, max, "pens"));
      });
      pen.appendChild(yard);
      wrap.appendChild(pen);
    });
    if (totalCount > invs.length) wrap.appendChild(el("div", "file-note", `Pens show the ${invs.length} largest holdings · ${totalCount - invs.length} more in the ledger and charts below.`));
  }

  function renderBiome() {
    const wrap = $("#biome-view");
    if (!wrap) return;
    wrap.innerHTML = "";
    const mode = coerceBiomeMode(ui.biomeMode);
    const floating = mode === "float";
    const penned = mode === "pens";
    wrap.classList.toggle("is-floating", floating);
    wrap.classList.toggle("is-pens", penned);
    wrap.classList.toggle("is-terrarium", !floating);
    wrap.setAttribute("aria-label", BIOME_MODE_META[mode].aria);
    const invs = Data.all().slice().sort((a, b) => invMagnitude(b) - invMagnitude(a));
    const max = Math.max(...invs.map(invMagnitude), 1);
    const visibleInvs = invs.slice(0, 28);
    const floatLayout = floating ? floatLayoutFor(visibleInvs, max) : new Map();
    if (penned) {
      renderBiomePens(wrap, visibleInvs, max, invs.length);
      return;
    }
    visibleInvs.forEach((inv, idx) => {
      wrap.appendChild(createBiomeEntityCard(inv, idx, max, mode, { floatLayout, wrap }));
    });
    if (invs.length > 28) wrap.appendChild(el("div", "file-note", `Showing the 28 largest holdings · ${invs.length - 28} more in the ledger and charts below.`));
  }

  function institutionGroups(invs) {
    const groups = new Map();
    invs.forEach(inv => {
      const instName = cleanTag(inv.Institution);
      const acctName = cleanTag(inv["Account Type"]);
      const value = invMagnitude(inv);
      if (!groups.has(instName)) {
        groups.set(instName, { name: instName, value: 0, debtValue: 0, count: 0, accounts: new Map(), holdings: [] });
      }
      const inst = groups.get(instName);
      if (!inst.accounts.has(acctName)) inst.accounts.set(acctName, { name: acctName, value: 0, count: 0 });
      const acct = inst.accounts.get(acctName);
      inst.value += value;
      inst.debtValue += inv.Kind === "Debt" ? value : 0;
      inst.count += 1;
      inst.holdings.push(inv);
      acct.value += value;
      acct.count += 1;
    });

    const valueSort = (a, b) => (b.value - a.value) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    const positionSort = (a, b) => (invMagnitude(b) - invMagnitude(a)) || positionLabel(a).localeCompare(positionLabel(b), undefined, { numeric: true, sensitivity: "base" });
    return [...groups.values()].sort(valueSort).map((inst, idx) => ({
      ...inst,
      idx,
      accounts: [...inst.accounts.values()].sort(valueSort),
      holdings: inst.holdings.slice().sort(positionSort)
    }));
  }

  /* ---------- ledger table ---------- */

  const pill = (txt) => txt
    ? `<span class="tag-pill" style="color:${colorFor(txt)};border-color:${colorFor(txt)}55">${txt}</span>`
    : `<span style="color:var(--faint)">—</span>`;

  const LEDGER_HEADERS = `
    <thead>
      <tr>
        <th class="num">ID</th><th>Ticker</th><th>Institution</th><th>Account</th>
        <th>Kind</th><th>Vehicle</th><th>Vehicle Category</th>
        <th class="num">Shares</th><th class="num">Price</th><th class="num">Value</th><th class="num">Rate</th><th class="num">Tax</th><th>Amort</th><th></th>
      </tr>
    </thead>`;

  function ledgerSortValue(inv) {
    if (ui.ledgerSort === "ID") return Number(inv.ID) || 0;
    return cleanTag(inv[ui.ledgerSort]).toLocaleLowerCase();
  }

  function sortedLedgerRows(rows) {
    const dir = ui.ledgerSortDir === "desc" ? -1 : 1;
    return rows.slice().sort((a, b) => {
      const av = ledgerSortValue(a), bv = ledgerSortValue(b);
      let cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
      if (cmp === 0) cmp = Number(a.ID) - Number(b.ID);
      return cmp * dir;
    });
  }

  function appendLedgerRows(tbody, rows) {
    rows.forEach(inv =>
      tbody.appendChild(inv.ID === ui.editingId ? editRow(inv) : displayRow(inv)));
  }

  function ledgerTable(rows) {
    const scroll = el("div", "table-scroll");
    const table = el("table");
    table.innerHTML = `${LEDGER_HEADERS}<tbody></tbody>`;
    appendLedgerRows(table.querySelector("tbody"), rows);
    scroll.appendChild(table);
    return scroll;
  }

  function renderGroupedLedger(wrap, rows) {
    const groups = new Map();
    rows.forEach(inv => {
      const institution = cleanTag(inv.Institution);
      if (!groups.has(institution)) groups.set(institution, []);
      groups.get(institution).push(inv);
    });
    [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })).forEach(institution => {
      const groupRows = groups.get(institution);
      const total = groupRows.reduce((sum, inv) => sum + Data.presentValue(inv, false), 0);
      const group = el("div", "ledger-group");
      const head = el("div", "ledger-group-head");
      head.appendChild(el("h3", null, institution));
      head.appendChild(el("span", null, `${fmt$full(total)} · ${groupRows.length} position${groupRows.length === 1 ? "" : "s"}`));
      group.appendChild(head);
      group.appendChild(ledgerTable(sortedLedgerRows(groupRows)));
      wrap.appendChild(group);
    });
  }

  // A number input paired with a −/+ button so optional numeric fields can be
  // removed (stored as ""). read() returns "" when off.
  function removableNumber(initial, opts = {}) {
    const wrap = el("span", opts.className || "tax-field");
    const inp = el("input");
    inp.type = "number";
    if (opts.step != null) inp.step = opts.step;
    if (opts.min != null) inp.min = opts.min;
    if (opts.placeholder != null) inp.placeholder = opts.placeholder;
    const btn = el("button", "mini-btn"); btn.type = "button";
    let on = initial !== "" && initial != null && !isNaN(initial);
    let last = on ? initial : (opts.defaultValue ?? "");
    inp.value = on ? initial : "";
    const apply = () => {
      inp.disabled = !on;
      wrap.classList.toggle("off", !on);
      btn.textContent = on ? "−" : "+";
      btn.title = on ? (opts.removeTitle || "Remove this value") : (opts.addTitle || "Add this value");
    };
    btn.addEventListener("click", () => {
      on = !on;
      if (on) inp.value = last;
      else { last = inp.value || last; inp.value = ""; }
      apply();
    });
    apply();
    wrap.appendChild(inp); wrap.appendChild(btn);
    return {
      wrap,
      input: inp,
      setHidden: hidden => { wrap.hidden = hidden; },
      setValue: value => {
        const next = value === "" || value == null ? "" : String(value);
        if (next !== "") last = next;
        inp.value = next;
        on = next !== "";
        apply();
      },
      read: () => (on && inp.value !== "") ? Number(inp.value) : (opts.defaultWhenBlank ?? "")
    };
  }

  function removableRate(initial) {
    return removableNumber(initial, {
      step: "0.005",
      min: "0",
      defaultValue: Data.DEFAULTS["Nominal tax rate"],
      defaultWhenBlank: Data.DEFAULTS["Nominal tax rate"],
      removeTitle: "Tax doesn't apply — remove it",
      addTitle: "Add a tax rate"
    });
  }

  function wireRemovableInput(inp, btn, opts = {}) {
    let on = opts.initialOn ?? (inp.value !== "" && !isNaN(inp.value));
    let last = on ? inp.value : (opts.defaultValue ?? "");
    const apply = () => {
      inp.disabled = !on;
      inp.closest(".tax-field").classList.toggle("off", !on);
      btn.textContent = on ? "−" : "+";
      btn.title = on ? (opts.removeTitle || "Remove this value") : (opts.addTitle || "Add this value");
    };
    btn.addEventListener("click", () => {
      on = !on;
      if (on) inp.value = last;
      else { last = inp.value || last; inp.value = ""; }
      apply();
    });
    apply();
    return {
      read: () => (on && inp.value !== "") ? Number(inp.value) : (opts.defaultWhenBlank ?? ""),
      setValue: value => {
        const next = value === "" || value == null ? "" : String(value);
        if (next !== "") last = next;
        inp.value = next;
        on = next !== "";
        apply();
      },
      clear: () => { last = inp.value || last; inp.value = ""; on = false; apply(); }
    };
  }

  function currencyInputValue(value) {
    return value === "" ? "" : Number(value).toFixed(2);
  }

  function sameCurrencyValue(a, b) {
    if (a === "" || b === "") return false;
    return Math.abs(Number(a) - Number(b)) < 0.005;
  }

  function inferPaymentInputValue(principal, annualRate, months) {
    return currencyInputValue(Data.inferAmortPayment(principal, annualRate, months));
  }

  function wireAutoAmortPayment(opts) {
    const { kindInput, monthsInput, paymentControl, paymentInput, dependencyInputs, principal, annualRate } = opts;
    let settingAuto = false;
    let lastAuto = inferPaymentInputValue(principal(), annualRate(), monthsInput.value);
    let paymentManual = paymentInput.value !== "" && !sameCurrencyValue(paymentInput.value, lastAuto);

    const currentLooksAuto = () => paymentInput.value === "" || sameCurrencyValue(paymentInput.value, lastAuto);

    const refresh = () => {
      if (kindInput.value !== "Debt") return;
      if (paymentInput.value === "") paymentManual = false;
      if (paymentInput.value !== "" && !currentLooksAuto()) paymentManual = true;
      if (paymentManual) return;

      const next = inferPaymentInputValue(principal(), annualRate(), monthsInput.value);
      if (next === "") return;
      settingAuto = true;
      paymentControl.setValue(next);
      settingAuto = false;
      lastAuto = next;
      paymentManual = false;
    };

    paymentInput.addEventListener("input", () => {
      if (settingAuto) return;
      const next = inferPaymentInputValue(principal(), annualRate(), monthsInput.value);
      if (paymentInput.value === "") {
        paymentManual = false;
      } else {
        paymentManual = !sameCurrencyValue(paymentInput.value, next);
        if (!paymentManual) lastAuto = next;
      }
    });
    monthsInput.addEventListener("input", refresh);
    monthsInput.addEventListener("change", refresh);
    kindInput.addEventListener("change", refresh);
    dependencyInputs.forEach(inputEl => {
      inputEl.addEventListener("input", refresh);
      inputEl.addEventListener("change", refresh);
    });
    refresh();
    return refresh;
  }

  // A read-only ledger row, with Edit / remove actions.
  function displayRow(inv) {
    const tr = el("tr");
    const debt = inv.Kind === "Debt";
    const kindPill = `<span class="tag-pill ${debt ? "kind-debt" : "kind-asset"}">${inv.Kind}</span>`;
    const valMag = Data.presentValue(inv, false);
    const valCell = inv.Value === ""
      ? `<span style="color:var(--faint)" title="unpriced — valued at $1/share">${fmt$cents(debt ? -valMag : valMag)}*</span>`
      : (debt ? `<span class="kind-debt">−${fmt$cents(valMag)}</span>` : fmt$cents(inv.Value));
    const pps = Data.pricePerShare(inv);
    const priceCell = pps === "" ? `<span style="color:var(--faint)">—</span>` : fmt$cents(pps);
    const taxCell = inv["Nominal tax rate"] === ""
      ? `<span style="color:var(--faint)" title="tax doesn't apply">n/a</span>`
      : fmtPct(inv["Nominal tax rate"]);
    const amortCell = !debt
      ? `<span style="color:var(--faint)">—</span>`
      : Data.isAmortized(inv)
        ? `<span class="amort-badge" title="amortizing — pays down on schedule">↓ ${inv["Amort Months"]}mo · ${fmt$(inv["Amort Payment"])}/mo</span>`
        : `<span style="color:var(--faint)" title="carries and grows at its rate">carries</span>`;
    tr.innerHTML = `
      <td class="num" style="color:var(--faint)">${inv.ID}</td>
      <td><b>${inv.Ticker || "—"}</b></td>
      <td>${pill(inv.Institution)}</td>
      <td>${pill(inv["Account Type"])}</td>
      <td>${kindPill}</td>
      <td>${pill(inv.Category)}</td>
      <td>${pill(inv.Subcategory)}</td>
      <td class="num">${inv.Amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
      <td class="num">${priceCell}</td>
      <td class="num">${valCell}</td>
      <td class="num">${fmtPct(inv["Nominal Rate"])}</td>
      <td class="num">${taxCell}</td>
      <td>${amortCell}</td>
      <td class="row-actions"></td>`;
    const edit = el("button", "edit-btn", "edit");
    edit.addEventListener("click", () => { ui.editingId = inv.ID; renderAll(); });
    const del = el("button", "del-btn ghost-danger", "remove");
    del.addEventListener("click", () => Data.remove(inv.ID));
    tr.lastElementChild.appendChild(edit);
    tr.lastElementChild.appendChild(del);
    return tr;
  }

  // The same row, editable in place. Save writes through Data.update.
  function editRow(inv) {
    const tr = el("tr", "editing");
    const cell = (child, cls) => { const td = el("td", cls); td.appendChild(child); return td; };
    const input = (val, attrs = {}) => {
      const i = el("input");
      i.value = val ?? "";
      for (const k in attrs) i.setAttribute(k, attrs[k]);
      return i;
    };
    const fTicker = input(inv.Ticker, { type: "text" });
    const fInst = input(inv.Institution, { type: "text", list: "dl-Institution" });
    const fAcct = input(inv["Account Type"], { type: "text", list: "dl-Account-Type" });
    const fKind = el("select");
    Data.KINDS.forEach(k => {
      const o = el("option"); o.value = k; o.textContent = k;
      if (inv.Kind === k) o.selected = true;
      fKind.appendChild(o);
    });
    const fCat = input(inv.Category, { type: "text", list: "dl-Category" });
    const fSub = input(inv.Subcategory, { type: "text", list: "dl-Subcategory" });
    const fAmt = input(inv.Amount, { type: "number", step: "any", min: "0" });
    const pps0 = Data.pricePerShare(inv);
    const fPrice = input(pps0 === "" ? "" : +pps0.toFixed(6), { type: "number", step: "any", min: "0", placeholder: "$/share" });
    const fVal = input(inv.Value === "" ? "" : inv.Value, { type: "number", step: "any", placeholder: "auto" });
    const fRate = input(inv["Nominal Rate"], { type: "number", step: "0.005" });
    const tax = removableRate(inv["Nominal tax rate"]);

    // Amortization (debts only): months remaining + monthly payment. Each piece
    // is removable and stores "" when it does not apply.
    const amMonths = removableNumber(inv["Amort Months"], {
      step: "1", min: "0", placeholder: "mo",
      removeTitle: "Remove months left", addTitle: "Add months left"
    });
    const amPay = removableNumber(inv["Amort Payment"], {
      step: "any", min: "0", placeholder: "$/mo",
      removeTitle: "Remove monthly payment", addTitle: "Add monthly payment"
    });
    const amortWrap = el("span", "amort-field");
    amortWrap.appendChild(amMonths.wrap); amortWrap.appendChild(amPay.wrap);
    const syncAmort = () => {
      const isDebt = fKind.value === "Debt";
      amMonths.setHidden(!isDebt); amPay.setHidden(!isDebt);
      amortWrap.title = isDebt ? "Months remaining · monthly payment (leave blank to let it carry)" : "Amortization applies to debts only";
    };
    fKind.addEventListener("change", syncAmort);
    syncAmort();

    // Price ↔ Value are two views of the same thing: Value = shares × price.
    // Editing either recomputes the other; changing shares reprices from price.
    const shares = () => Number(fAmt.value) || 0;
    const syncFixedEditPrice = () => {
      const fixed = fixedPriceForTicker(fTicker.value);
      if (fixed == null) return false;
      fPrice.value = fixed;
      fVal.value = shares() ? +(shares() * fixed).toFixed(2) : "";
      return true;
    };
    fTicker.addEventListener("input", syncFixedEditPrice);
    fPrice.addEventListener("input", () => {
      if (syncFixedEditPrice()) return;
      if (fPrice.value !== "" && shares()) fVal.value = +(shares() * Number(fPrice.value)).toFixed(2);
    });
    fVal.addEventListener("input", () => {
      if (syncFixedEditPrice()) return;
      if (fVal.value !== "" && shares()) fPrice.value = +(Number(fVal.value) / shares()).toFixed(6);
    });
    fAmt.addEventListener("input", () => {
      if (syncFixedEditPrice()) return;
      if (fPrice.value !== "" && shares()) fVal.value = +(shares() * Number(fPrice.value)).toFixed(2);
      else if (fVal.value !== "" && shares()) fPrice.value = +(Number(fVal.value) / shares()).toFixed(6);
    });
    syncFixedEditPrice();

    const editDebtPrincipal = () => {
      if (fVal.value !== "" && Number.isFinite(Number(fVal.value))) return Math.abs(Number(fVal.value));
      if (fPrice.value !== "" && shares()) return Math.abs(shares() * Number(fPrice.value));
      return Math.abs(shares());
    };
    wireAutoAmortPayment({
      kindInput: fKind,
      monthsInput: amMonths.input,
      paymentControl: amPay,
      paymentInput: amPay.input,
      dependencyInputs: [fTicker, fAmt, fPrice, fVal, fRate],
      principal: editDebtPrincipal,
      annualRate: () => Number(fRate.value) || 0
    });

    const idTd = el("td", "num"); idTd.innerHTML = `<span style="color:var(--faint)">${inv.ID}</span>`;
    tr.appendChild(idTd);
    [fTicker, fInst, fAcct, fKind, fCat, fSub].forEach(f => tr.appendChild(cell(f)));
    [fAmt, fPrice, fVal, fRate].forEach(f => tr.appendChild(cell(f, "num")));
    tr.appendChild(cell(tax.wrap, "num"));
    tr.appendChild(cell(amortWrap));

    const actions = el("td", "row-actions");
    const save = el("button", "save-btn primary", "save");
    const cancel = el("button", null, "cancel");
    const commit = () => {
      const ticker = fTicker.value.trim().toUpperCase();
      const fixed = fixedPriceForTicker(ticker);
      // Clear the edit flag BEFORE the write: Data.update fires notify → renderAll
      // synchronously, and we want that render to draw the read-only row.
      ui.editingId = null;
      Data.update(inv.ID, {
        "Ticker": ticker,
        "Institution": fInst.value,
        "Account Type": fAcct.value,
        "Kind": fKind.value,
        "Category": fCat.value,
        "Subcategory": fSub.value,
        "Amount": fAmt.value,
        "Value": fixed == null ? (fVal.value === "" ? "" : Number(fVal.value)) : Number(fAmt.value) * fixed,
        "Nominal Rate": fRate.value,
        "Nominal tax rate": tax.read(),
        "Amort Months": fKind.value === "Debt" ? amMonths.read() : "",
        "Amort Payment": fKind.value === "Debt" ? amPay.read() : ""
      });
    };
    save.addEventListener("click", commit);
    cancel.addEventListener("click", () => { ui.editingId = null; renderAll(); });
    tr.addEventListener("keydown", e => {
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") { ui.editingId = null; renderAll(); }
    });
    actions.appendChild(save); actions.appendChild(cancel);
    tr.appendChild(actions);
    return tr;
  }

  function renderTable() {
    const wrap = $("#ledger-table-wrap");
    const controls = $("#ledger-controls");
    const rows = Data.all();
    const live = new Set(Data.all().map(i => i.ID));
    if (ui.editingId != null && !live.has(ui.editingId)) ui.editingId = null;
    wrap.innerHTML = "";
    if (ui.ledgerByInstitution) renderGroupedLedger(wrap, rows);
    else wrap.appendChild(ledgerTable(sortedLedgerRows(rows)));
    $("#ledger-empty").style.display = rows.length ? "none" : "block";
    wrap.style.display = rows.length ? "" : "none";
    if (controls) controls.style.display = rows.length ? "" : "none";
  }

  /* ---------- portfolio copy switcher ---------- */

  function renderCopyBar() {
    const sel = $("#copy-select");
    if (!sel) return;
    sel.innerHTML = "";
    Portfolios.list().forEach(c => {
      const o = el("option");
      o.value = c.id;
      o.textContent = `${c.name} · ${c.count} position${c.count === 1 ? "" : "s"}`;
      if (c.active) o.selected = true;
      sel.appendChild(o);
    });
    $("#copy-del").disabled = Portfolios.list().length <= 1 && Data.all().length === 0;
  }

  // Flash the "saved" badge dark for a beat, then let CSS ease it back to bright
  // — a quiet confirmation that the edit was persisted.
  let saveTimer;
  function pulseSaved() {
    const dot = $("#save-dot");
    if (!dot) return;
    clearTimeout(saveTimer);
    dot.classList.add("saving");     // snaps dark (transition:none)
    // hold the dark briefly, then remove so CSS eases it back to bright green
    saveTimer = setTimeout(() => dot.classList.remove("saving"), 110);
  }

  function wireCopies() {
    $("#copy-select").addEventListener("change", e => {
      saveUiState();
      Portfolios.switchTo(e.target.value);
      loadActiveContributionState();
      syncProjectionControlsToDom();
      renderAll();
    });
    $("#copy-new").addEventListener("click", () => {
      const name = prompt("Name for the new portfolio", "Untitled");
      if (name === null) return;
      Portfolios.create(name);
      resetContributionState();
      saveUiState();
      renderAll();
      toast("New portfolio created");
    });
    $("#copy-dup").addEventListener("click", () => {
      const contributionState = serializeContributionState();
      Portfolios.duplicate();
      applyContributionState(contributionState);
      saveUiState();
      renderAll();
      toast(`Duplicated → "${Portfolios.activeName()}"`);
    });
    $("#copy-rename").addEventListener("click", () => {
      const name = prompt("Rename portfolio", Portfolios.activeName());
      if (name === null || !name.trim()) return;
      Portfolios.rename(Portfolios.activeId(), name);
      renderCopyBar();
      toast("Renamed");
    });
    $("#copy-del").addEventListener("click", () => {
      if (!confirm(`Delete "${Portfolios.activeName()}"? This can't be undone.`)) return;
      Portfolios.remove(Portfolios.activeId());
      loadActiveContributionState();
      syncProjectionControlsToDom();
      saveUiState();
      renderAll();
      toast("Portfolio deleted");
    });
  }

  /* ---------- contribution target chips ---------- */

  // Auto-select all eligible positions until the user touches the chips, and
  // drop any ids that became ineligible (removed, or now an amortized debt).
  function syncContribIds() {
    const eligible = Data.all().filter(inv => !Data.isAmortized(inv));
    if (!ui.contribTouched) eligible.forEach(inv => ui.contribIds.add(inv.ID));
    const eligibleIds = new Set(eligible.map(i => i.ID));
    [...ui.contribIds].forEach(id => { if (!eligibleIds.has(id)) ui.contribIds.delete(id); });
    [...ui.contribAmounts.keys()].forEach(id => { if (!eligibleIds.has(id)) ui.contribAmounts.delete(id); });
  }

  function seedExactContribAmounts(perTarget) {
    Data.all().filter(inv => !Data.isAmortized(inv)).forEach(inv => {
      if (ui.contribIds.has(inv.ID) && !ui.contribAmounts.has(inv.ID)) {
        ui.contribAmounts.set(inv.ID, perTarget);
      }
    });
  }

  function exactContribTotal() {
    let total = 0;
    ui.contribIds.forEach(id => total += Math.max(0, Number(ui.contribAmounts.get(id)) || 0));
    return total;
  }

  function renderContribChips(contrib) {
    const wrap = $("#contrib-targets");
    const perTarget = contrib.perTarget;
    wrap.innerHTML = `<span class="ct-label">Contributing to</span>`;
    // Amortized debts run on their own schedule — not contribution targets.
    Data.all().filter(inv => !Data.isAmortized(inv)).forEach(inv => {
      const on = ui.contribIds.has(inv.ID);
      const debt = inv.Kind === "Debt";
      const exact = ui.contribTouched ? (Number(ui.contribAmounts.get(inv.ID)) || 0) : perTarget;
      const amt = (on && exact > 0) ? ` · ${debt ? "↓" : ""}${fmt$(exact)}/mo` : "";
      const item = el("span", "contrib-item");
      const chip = el("button", `chip${debt ? " chip-debt" : ""}`, `${positionLabel(inv)}<span class="chip-amt">${amt}</span>`);
      chip.setAttribute("aria-pressed", on);
      chip.title = debt
        ? `${inv.Institution} · ${inv["Account Type"]} — contributing pays this debt down`
        : `${inv.Institution} · ${inv["Account Type"]}`;
      chip.addEventListener("click", () => {
        if (!ui.contribTouched) {
          seedExactContribAmounts(perTarget);
          ui.contribTouched = true;
        }
        const fallback = perTarget || (exactContribTotal() || ui.monthly) / Math.max(ui.contribIds.size || 1, 1);
        if (ui.contribIds.has(inv.ID)) {
          ui.contribIds.delete(inv.ID);
          ui.contribAmounts.set(inv.ID, 0);
        } else {
          ui.contribIds.add(inv.ID);
          ui.contribAmounts.set(inv.ID, Number(ui.contribAmounts.get(inv.ID)) || fallback);
        }
        saveUiState();
        renderAll();
      });

      const amtInput = el("input", "contrib-amount");
      amtInput.type = "number"; amtInput.min = "0"; amtInput.step = "any";
      amtInput.value = on ? +exact.toFixed(2) : "";
      amtInput.placeholder = "$/mo";
      amtInput.disabled = !on;
      amtInput.setAttribute("aria-label", `Monthly contribution for ${positionLabel(inv)}`);
      amtInput.title = on ? "Exact monthly contribution for this position" : "Turn this position on to edit its contribution";
      const commitAmount = () => {
        if (!ui.contribTouched) {
          seedExactContribAmounts(perTarget);
          ui.contribTouched = true;
        }
        const amount = Math.max(0, Number(amtInput.value) || 0);
        ui.contribAmounts.set(inv.ID, amount);
        amount > 0 ? ui.contribIds.add(inv.ID) : ui.contribIds.delete(inv.ID);
        ui.contribTouched = true;
        saveUiState();
        renderAll();
      };
      amtInput.addEventListener("change", commitAmount);
      amtInput.addEventListener("keydown", e => {
        if (e.key === "Enter") amtInput.blur();
      });
      item.appendChild(chip);
      item.appendChild(amtInput);
      wrap.appendChild(item);
    });
    // Show amortized debts explicitly as locked so the exact-contribution affordance
    // is not confused with their scheduled paydown.
    const amortized = Data.all().filter(Data.isAmortized);
    amortized.forEach(inv => {
      const locked = el("span", "contrib-locked",
        `${positionLabel(inv)} locked · amortizes ${fmt$(inv["Amort Payment"])}/mo`);
      locked.title = "Amortized debts run on their own schedule and cannot receive exact contributions here";
      wrap.appendChild(locked);
    });
  }

  function amortizedMonthlyCost(inv) {
    const entered = Math.max(0, Number(inv["Amort Payment"]) || 0);
    const inferred = Number(Data.inferAmortPayment(
      Data.presentValue(inv, false),
      inv["Nominal Rate"],
      inv["Amort Months"]
    )) || 0;
    return Math.max(entered, inferred);
  }

  function renderAmortizedDebtCosts() {
    const wrap = $("#amort-costs");
    if (!wrap) return;
    const debts = Data.all().filter(Data.isAmortized);
    wrap.hidden = debts.length === 0;
    if (!debts.length) {
      wrap.innerHTML = "";
      return;
    }
    const rows = debts.map(inv => `
      <div class="amort-cost-row">
        <span>${positionLabel(inv)}:</span>
        <b>${fmt$full(amortizedMonthlyCost(inv))}/mo</b>
      </div>`).join("");
    wrap.innerHTML = `
      <div class="amort-cost-head">Scheduled debt costs</div>
      <div class="amort-cost-list">${rows}</div>
      <div class="amort-cost-note">outside contribution budget</div>`;
  }

  /* ---------- stats + projection readout ---------- */

  function renderStats(proj) {
    const invs = Data.all();
    const assets = Data.assetTotal(ui.taxOn), debts = Data.debtTotal(ui.taxOn);
    $("#stat-total").textContent = fmt$full(Data.total(ui.taxOn));
    $("#stat-total-sub").textContent = debts > 0
      ? `${fmt$(assets)} assets − ${fmt$(debts)} debts`
      : (ui.taxOn ? "after nominal withdrawal tax" : "pre-tax basis");
    $("#stat-count").textContent = invs.length;
    $("#stat-count-sub").textContent =
      new Set(invs.map(i => i.Institution || "—")).size + " institutions · " +
      new Set(invs.map(i => i["Account Type"] || "—")).size + " account types";
    $("#stat-rate").textContent = fmtPct(Data.weightedRate());
    $("#stat-proj").textContent = fmt$(proj.totals[proj.totals.length - 1]);
    $("#stat-proj-k").textContent = `Projected · ${ui.years}Y`;

    const end = proj.totals[proj.totals.length - 1];
    const { perTarget, count, total } = proj.contrib;
    const contributed = total * 12 * ui.years;
    const principal = Data.total(false);
    const splitTxt = count > 0 && ui.contribTouched
      ? `<span class="hl"><b>${fmt$full(total)}</b>/mo exact → <b>${count}</b> position${count === 1 ? "" : "s"}</span>`
      : count > 0
      ? `<span class="hl">${fmt$full(ui.monthly)}/mo → <b>${count}</b> position${count === 1 ? "" : "s"} · <b>${fmt$full(perTarget)}</b> each</span>`
      : `<span>no contribution targets selected</span>`;
    $("#proj-readout").innerHTML = `
      ${splitTxt}
      <span>end value <b>${fmt$full(end)}</b></span>
      <span>principal <b>${fmt$full(principal)}</b></span>
      <span>contributed <b>${fmt$full(contributed)}</b></span>
      <span>growth <b>${fmt$full(Math.max(end - principal - contributed, 0))}</b></span>
      <span>${ui.taxOn ? "post-tax · " : ""}rates are real (inflation baked in)</span>`;
  }

  function renderAggregateProjectionReadout(proj) {
    const N = proj.months.length - 1;
    const startAssets = proj.assets[0];
    const startDebts = proj.debts[0];
    const endAssets = proj.assets[N];
    const endDebts = proj.debts[N];
    const endNet = endAssets - endDebts;
    $("#proj-readout").innerHTML = `
      <span class="hl"><b>${fmtPct(proj.rate)}</b>/yr aggregate rate</span>
      <span>assets <b>${fmt$full(startAssets)}</b> → <b>${fmt$full(endAssets)}</b></span>
      <span>debt <b>${fmt$full(startDebts)}</b> → <b>${fmt$full(endDebts)}</b></span>
      <span>end net <b>${fmt$full(endNet)}</b></span>
      <span>${ui.taxOn ? "post-tax · " : ""}debt shown as positive balance</span>
      <span>${proj.debt.amortized ? `${proj.debt.amortized} amortizing debt${proj.debt.amortized === 1 ? "" : "s"} follow schedules` : "no scheduled debt paydown"}${proj.debt.carried ? ` · ${proj.debt.carried} carried at aggregate rate` : ""}</span>`;
  }

  /* ---------- balance sheet + debts ---------- */

  function renderBalanceSheet() {
    const assets = Data.assetTotal(ui.taxOn), debts = Data.debtTotal(ui.taxOn);
    const net = assets - debts;
    const scale = Math.max(assets, debts, 1);
    $("#balance-sheet").innerHTML = `
      <div class="bsheet">
        <div class="bsheet-row">
          <span class="bs-lbl">Assets</span>
          <div class="bs-track"><div class="bs-fill assets" style="width:${(assets / scale * 100).toFixed(1)}%"></div></div>
          <span class="bs-val">${fmt$full(assets)}</span>
        </div>
        <div class="bsheet-row">
          <span class="bs-lbl">Debts</span>
          <div class="bs-track"><div class="bs-fill debts" style="width:${(debts / scale * 100).toFixed(1)}%"></div></div>
          <span class="bs-val debt">${debts > 0 ? "−" : ""}${fmt$full(debts)}</span>
        </div>
        <div class="bsheet-net">
          <span class="bs-lbl">Net worth</span>
          <span class="bs-net-val">${fmt$full(net)}</span>
          <span class="bs-note">${debts > 0 ? "assets − debts" : "no debts recorded"}${ui.taxOn ? " · post-tax" : ""}</span>
        </div>
      </div>`;
  }

  function renderDebts() {
    const section = $("#debt-section");
    const anyDebt = Data.all().some(Data.isDebt);
    section.style.display = anyDebt ? "block" : "none";
    if (!anyDebt) return;
    hBars($("#debt-bars"), Data.groupBy("Ticker", ui.taxOn, Data.isDebt));
    hBars($("#debt-inst-bars"), Data.groupBy("Institution", ui.taxOn, Data.isDebt));
  }

  /* ---------- master render ---------- */

  function renderAll() {
    const hasData = Data.all().length > 0;
    $("#dashboard").style.display = hasData ? "block" : "none";
    $("#hero-empty").style.display = hasData ? "none" : "block";
    renderCopyBar();
    renderTable();
    if (!hasData) { renderContribChips({ perTarget: 0, count: 0, total: 0 }); return; }

    syncContribIds();
    const proj = Data.projection({
      years: ui.years, monthlyTotal: ui.monthly,
      contribIds: ui.contribIds,
      contribAmounts: ui.contribTouched ? ui.contribAmounts : null,
      taxOn: ui.taxOn
    });
    const aggregateProj = Data.aggregateProjection({
      years: ui.years,
      rate: ui.simpleRate,
      taxOn: ui.taxOn
    });
    syncProjectionModeToDom();
    syncBiomeModeToDom();
    $("#monthly-out").textContent = fmt$full(ui.monthly) + "/mo";
    $("#simple-rate-out").textContent = fmtPct(ui.simpleRate) + "/yr";
    const controlsSummary = $("#proj-controls-summary");
    if (controlsSummary) {
      controlsSummary.textContent = ui.projectionView === "simple"
        ? `${ui.years}Y · ${fmtPct(ui.simpleRate)}/yr · scheduled debt${ui.taxOn ? " · post-tax" : ""}`
        : `${ui.years}Y · ${ui.contribTouched ? fmt$(proj.contrib.total) + "/mo exact" : fmt$(ui.monthly) + "/mo"} · ${proj.contrib.count} target${proj.contrib.count === 1 ? "" : "s"}${ui.taxOn ? " · post-tax" : ""}`;
    }
    renderContribChips(proj.contrib);
    renderAmortizedDebtCosts();
    renderStats(proj);
    renderHeroExperience(proj);
    renderBiome();
    if (ui.projectionView === "simple") {
      aggregateLineChart($("#proj-chart"), aggregateProj);
      renderAggregateProjectionReadout(aggregateProj);
    } else {
      stackedArea($("#proj-chart"), proj);
    }
    renderBalanceSheet();

    // Composition is scoped to INVESTED ASSETS so donut/bar totals equal what's
    // invested (not net worth). Debts get their own section below.
    const invested = Data.assetTotal(ui.taxOn);
    $("#donut-scope-note").textContent = `${fmt$full(invested)} invested${ui.taxOn ? " · post-tax" : ""}`;

    const grid = $("#donut-grid");
    grid.innerHTML = "";
    ASSET_DIMS.forEach(dim =>
      donut(grid, "% by " + dimLabel(dim), Data.groupBy(dim, ui.taxOn, Data.isAsset), "invested"));

    hBars($("#ticker-bars"), Data.groupBy("Ticker", ui.taxOn, Data.isAsset));
    stackBars($("#xtab-account-category"), Data.crossTab("Account Type", "Category", ui.taxOn, Data.isAsset));
    stackBars($("#xtab-institution-account"), Data.crossTab("Institution", "Account Type", ui.taxOn, Data.isAsset));

    renderDebts();
  }

  /* ---------- controls wiring ---------- */

  function wireControls() {
    const years = $("#years-slider"), monthly = $("#monthly-slider"), simpleRate = $("#simple-rate-slider");
    syncProjectionControlsToDom();
    $("#proj-view-detailed").addEventListener("click", () => {
      ui.projectionView = "detailed";
      saveUiState();
      renderAll();
    });
    $("#proj-view-simple").addEventListener("click", () => {
      ui.projectionView = "simple";
      saveUiState();
      renderAll();
    });
    $("#biome-whistle").addEventListener("click", () => {
      ui.biomeMode = nextBiomeModeKey(ui.biomeMode);
      saveUiState();
      renderAll();
    });
    years.addEventListener("input", () => {
      ui.years = rangeValue(years.value, RANGE_LIMITS.years);
      years.value = String(ui.years);
      $("#years-out").textContent = ui.years + " yrs";
      saveUiState();
      renderAll();
    });
    monthly.addEventListener("input", () => {
      ui.monthly = rangeValue(monthly.value, RANGE_LIMITS.monthly);
      monthly.value = String(ui.monthly);
      $("#monthly-out").textContent = fmt$full(ui.monthly) + "/mo";
      saveUiState();
      renderAll();
    });
    simpleRate.addEventListener("input", () => {
      ui.simpleRate = rangeValue(Number(simpleRate.value) / 100, RANGE_LIMITS.simpleRate);
      simpleRate.value = String(+(ui.simpleRate * 100).toFixed(3));
      $("#simple-rate-out").textContent = fmtPct(ui.simpleRate) + "/yr";
      saveUiState();
      renderAll();
    });
    document.querySelectorAll(".tax-toggle").forEach(t =>
      t.addEventListener("change", () => {
        ui.taxOn = t.checked;
        document.querySelectorAll(".tax-toggle").forEach(o => o.checked = ui.taxOn);
        saveUiState();
        renderAll();
      }));
    $("#ledger-sort").addEventListener("change", e => {
      ui.ledgerSort = e.target.value;
      renderAll();
    });
    $("#ledger-sort-dir").addEventListener("click", e => {
      ui.ledgerSortDir = ui.ledgerSortDir === "asc" ? "desc" : "asc";
      e.currentTarget.textContent = ui.ledgerSortDir === "asc" ? "A-Z" : "Z-A";
      renderAll();
    });
    $("#ledger-by-institution").addEventListener("change", e => {
      ui.ledgerByInstitution = e.target.checked;
      renderAll();
    });
  }

  /* ---------- add form ---------- */

  function wireForm() {
    // datalists from suggestions + existing values
    function refreshDatalists() {
      ["Institution", "Account Type", "Category", "Subcategory"].forEach(dim => {
        const dl = $("#dl-" + dim.replace(" ", "-"));
        const opts = new Set(Data.SUGGESTIONS[dim] || []);
        Data.all().forEach(i => { if (i[dim]) opts.add(i[dim]); });
        dl.innerHTML = [...opts].map(o => `<option value="${o}">`).join("");
      });
    }
    Data.subscribe(refreshDatalists);
    refreshDatalists();

    // Optional fields use the same −/+ control: off stores "".
    const taxInput = $("#f-tax");
    const tax = wireRemovableInput(taxInput, $("#f-tax-toggle"), {
      defaultValue: String(Data.DEFAULTS["Nominal tax rate"]),
      defaultWhenBlank: Data.DEFAULTS["Nominal tax rate"],
      initialOn: true,
      removeTitle: "This position isn't taxed — remove it",
      addTitle: "Add a tax rate"
    });
    const amMonths = wireRemovableInput($("#f-amort-months"), $("#f-amort-months-toggle"), {
      removeTitle: "Remove months left",
      addTitle: "Add months left"
    });
    const amPay = wireRemovableInput($("#f-amort-pay"), $("#f-amort-pay-toggle"), {
      removeTitle: "Remove monthly payment",
      addTitle: "Add monthly payment"
    });

    // Amortization inputs only make sense for debts — show them when Kind = Debt.
    const kindSel = $("#f-kind");
    const syncFormAmort = () => {
      const isDebt = kindSel.value === "Debt";
      document.querySelectorAll(".amort-only").forEach(n => n.hidden = !isDebt);
      if (!isDebt) { amMonths.clear(); amPay.clear(); }
    };
    kindSel.addEventListener("change", syncFormAmort);
    syncFormAmort();

    const tickerInput = $("#f-ticker");
    const priceInput = $("#f-price");
    const syncFixedFormPrice = () => {
      const fixed = fixedPriceForTicker(tickerInput.value);
      if (fixed != null) priceInput.value = fixed;
    };
    tickerInput.addEventListener("input", syncFixedFormPrice);
    tickerInput.addEventListener("change", syncFixedFormPrice);

    const formDebtPrincipal = () => {
      const shares = Number($("#f-amount").value) || 0;
      const fixed = fixedPriceForTicker(tickerInput.value);
      const price = fixed == null ? Number(priceInput.value) : fixed;
      return price > 0 ? Math.abs(shares * price) : Math.abs(shares);
    };
    const refreshFormAmortPayment = wireAutoAmortPayment({
      kindInput: kindSel,
      monthsInput: $("#f-amort-months"),
      paymentControl: amPay,
      paymentInput: $("#f-amort-pay"),
      dependencyInputs: [tickerInput, $("#f-amount"), priceInput, $("#f-rate")],
      principal: formDebtPrincipal,
      annualRate: () => Number($("#f-rate").value) || 0
    });

    $("#add-btn").addEventListener("click", () => {
      const f = id => $("#f-" + id).value;
      if (!f("ticker").trim()) { toast("Ticker is required"); $("#f-ticker").focus(); return; }
      if (!f("amount") || Number(f("amount")) <= 0) { toast("Enter a share count"); $("#f-amount").focus(); return; }
      const ticker = f("ticker").trim().toUpperCase();
      const fixed = fixedPriceForTicker(ticker);
      const shares = Number(f("amount"));
      const price = fixed == null ? Number(f("price")) : fixed;
      const isDebt = f("kind") === "Debt";
      Data.add({
        "Ticker": ticker,
        "Institution": f("institution"),
        "Account Type": f("account"),
        "Kind": f("kind"),
        "Amount": shares,
        "Value": price > 0 ? shares * price : "",   // Value derived from shares × price
        "Category": f("category"),
        "Subcategory": f("subcategory"),
        "Nominal Rate": f("rate"),
        "Nominal tax rate": tax.read(),
        "Amort Months": isDebt ? amMonths.read() : "",
        "Amort Payment": isDebt ? amPay.read() : ""
      });
      ["ticker", "amount", "price"].forEach(id => $("#f-" + id).value = "");
      amMonths.clear(); amPay.clear();
      toast("Position added");
      $("#f-ticker").focus();
    });

    // Fetch a live $/share price for whatever ticker is typed, into the price field.
    // On failure the user just keeps typing their own value.
    const fetchBtn = $("#fetch-price");
    fetchBtn.addEventListener("click", async () => {
      const sym = $("#f-ticker").value.trim().toUpperCase();
      if (!sym) { toast("Enter a ticker first"); $("#f-ticker").focus(); return; }
      const label = fetchBtn.textContent;
      fetchBtn.disabled = true; fetchBtn.textContent = "…";
      try {
        const q = await Prices.quote(sym);
        $("#f-price").value = q.price;
        refreshFormAmortPayment();
        toast(`${q.ticker} · $${q.price.toLocaleString(undefined, { maximumFractionDigits: 2 })} · ${q.source}`);
      } catch {
        toast(`No live price for ${sym} — enter it manually`);
        $("#f-price").focus();
      } finally {
        fetchBtn.disabled = false; fetchBtn.textContent = label;
      }
    });
  }

  /* ---------- load / save ---------- */

  async function writeClipboardText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Fall back below for browsers that allow execCommand from a click even
        // when the async Clipboard API is blocked.
      }
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand && document.execCommand("copy");
    ta.remove();
    if (!ok) throw new Error("clipboard write is unavailable in this browser");
  }

  async function readClipboardText() {
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
      throw new Error("clipboard read requires HTTPS/GitHub Pages or browser permission");
    }
    try {
      return await navigator.clipboard.readText();
    } catch {
      throw new Error("clipboard read was blocked; allow clipboard access and try again");
    }
  }

  function parseClipboardBackup(text) {
    if (!text.trim()) throw new Error("clipboard is empty; export a backup first");
    return Data.parseText(text);
  }

  function wireIO() {
    $("#copy-json").addEventListener("click", async () => {
      const backup = Data.toJSON();
      try {
        await writeClipboardText(backup);
        toast("Backup copied to clipboard");
      } catch (err) {
        toast("Couldn't copy backup: " + err.message);
      }
    });

    document.querySelectorAll(".load-json").forEach(b => b.addEventListener("click", async e => {
      const btn = e.currentTarget;
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Reading…";
      try {
        const investments = parseClipboardBackup(await readClipboardText());
        Portfolios.importCopy("Imported from clipboard", investments);
        resetContributionState();
        saveUiState();
        renderAll();
        toast(`Imported ${Data.all().length} positions into "${Portfolios.activeName()}"`);
      } catch (err) {
        toast("Clipboard import failed: " + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    }));

    // Re-price every auto-priced holding: fixed-price tickers like USD plus
    // positions that look like securities (see looksTradable). Call-signs like
    // HOUSE/DEBT and cash/loans keep their manual value.
    const refreshBtn = $("#refresh-prices");
    refreshBtn.addEventListener("click", async () => {
      const invs = Data.all();
      if (invs.length === 0) { toast("Nothing to price yet"); return; }
      const tradable = invs.filter(shouldAutoPrice);
      if (tradable.length === 0) { toast("No auto-priced tickers — values are manual"); return; }
      const label = refreshBtn.textContent;
      refreshBtn.disabled = true; refreshBtn.textContent = "Pricing…";
      try {
        const quotes = await Prices.quoteMany(tradable.map(i => i.Ticker));
        let priced = 0;
        tradable.forEach(inv => {
          const q = quotes.get((inv.Ticker || "").toUpperCase());
          if (q) { Data.update(inv.ID, { "Value": inv.Amount * q.price }); priced++; }
        });
        const missed = tradable.length - priced;
        toast(priced
          ? `Priced ${priced}/${tradable.length}${missed ? ` · ${missed} unresolved` : ""}`
          : "No prices found — enter values manually");
      } catch (err) {
        toast("Price refresh failed: " + err.message);
      } finally {
        refreshBtn.disabled = false; refreshBtn.textContent = label;
      }
    });

    $("#seed-btn").addEventListener("click", () => {
      // Amount = shares; Value = shares × an approximate price, stamped at entry.
      // Hit "Refresh prices" to pull these to the live market.
      Data.loadArray([
        { "ID": 1, "Ticker": "QQQ", "Institution": "Robinhood", "Account Type": "Brokerage", "Kind": "Asset", "Amount": 40,  "Value": 28480, "Category": "Stock",  "Subcategory": "Index",         "Nominal Rate": 0.08, "Nominal tax rate": 0.15 },
        { "ID": 2, "Ticker": "QQQ", "Institution": "Robinhood", "Account Type": "Roth IRA",  "Kind": "Asset", "Amount": 60,  "Value": 42720, "Category": "Stock",  "Subcategory": "Index",         "Nominal Rate": 0.08, "Nominal tax rate": 0 },
        { "ID": 3, "Ticker": "QQQ", "Institution": "Robinhood", "Account Type": "Trad IRA",  "Kind": "Asset", "Amount": 80,  "Value": 56960, "Category": "Stock",  "Subcategory": "Index",         "Nominal Rate": 0.08, "Nominal tax rate": 0.15 },
        { "ID": 4, "Ticker": "SMH", "Institution": "Robinhood", "Account Type": "Brokerage", "Kind": "Asset", "Amount": 50,  "Value": 13000, "Category": "Stock",  "Subcategory": "Growth Stocks", "Nominal Rate": 0.09, "Nominal tax rate": 0.15 },
        { "ID": 5, "Ticker": "VOO", "Institution": "Robinhood", "Account Type": "Brokerage", "Kind": "Asset", "Amount": 30,  "Value": 16800, "Category": "Stock",  "Subcategory": "Index",         "Nominal Rate": 0.08, "Nominal tax rate": 0.15 },
        { "ID": 6, "Ticker": "VOO", "Institution": "Robinhood", "Account Type": "Trad IRA",  "Kind": "Asset", "Amount": 45,  "Value": 25200, "Category": "Stock",  "Subcategory": "Index",         "Nominal Rate": 0.08, "Nominal tax rate": 0.15 },
        { "ID": 7, "Ticker": "BTC", "Institution": "Robinhood", "Account Type": "Wallet",    "Kind": "Asset", "Amount": 0.5, "Value": 30750, "Category": "Crypto", "Subcategory": "",              "Nominal Rate": 0.12, "Nominal tax rate": 0.15 },
        { "ID": 8, "Ticker": "ETH", "Institution": "Coinbase",  "Account Type": "Wallet",    "Kind": "Asset", "Amount": 5,   "Value": 8550,  "Category": "Crypto", "Subcategory": "",              "Nominal Rate": 0.12, "Nominal tax rate": 0.15 }
      ]);
      resetContributionState();
      saveUiState();
      renderAll();
      toast("Sample portfolio loaded");
    });
  }

  /* ---------- boot ---------- */

  loadStoredProjectionState();
  wireControls();
  wireForm();
  wireIO();
  wireCopies();

  // Portfolios.init() restores the active copy from localStorage (seeding a
  // "Default" from tickers.json only on first run), then we subscribe the
  // renderer so it draws once against restored state.
  Portfolios.init().then(() => {
    loadActiveContributionState();
    syncProjectionControlsToDom();
    Data.subscribe(renderAll);
    Data.subscribe(pulseSaved);   // subscribed after init, so boot's initial load doesn't pulse
    renderAll();
  });

})();
