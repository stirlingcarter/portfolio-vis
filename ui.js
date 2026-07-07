/* ============================================================
   PRESENTATION LAYER — reads only from Data, never mutates
   investment fields directly. All charts are hand-rolled SVG.
   ============================================================ */

(() => {

  /* ---------- palette & formatting ---------- */

  // Wide, hue-varied palette ordered so adjacent picks contrast strongly.
  const PALETTE = [
    "#78ffd6", "#75d7ff", "#f4d96c", "#b994ff", "#ff7bbd",
    "#8dff8f", "#ff9f6e", "#6be8ff", "#d3ff62", "#ff8776",
    "#a7b5ff", "#6fffb8", "#ffc46b", "#d486ff", "#9df1ff",
    "#f7a7c8"
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
    contribIds: new Set(),
    contribAmounts: new Map(), // exact monthly dollars per selected position after user edits
    contribTouched: false,  // once the user picks targets, stop auto-selecting new ones
    editingId: null,        // ledger row currently being edited in place (or null)
    ledgerSort: "ID",
    ledgerSortDir: "asc",
    ledgerByInstitution: false
  };

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
  const shapeFor = inv => {
    const category = cleanTag(inv.Category).toLowerCase();
    if (inv.Kind === "Debt") return "debt";
    if (category.includes("crypto") || category.includes("bond") || category.includes("cash")) return "crystal";
    if (category.includes("real") || category.includes("stock") || category.includes("fund")) return "plant";
    return "vehicle";
  };

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

    const core = el("div", "hero-core", `<b>${fmt$(Data.total(ui.taxOn))}</b><span>${ui.taxOn ? "post-tax" : "net worth"}</span>`);
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
    if (shape === "crystal") return `<div class="entity crystal"><span class="facet"></span></div>`;
    if (shape === "vehicle") {
      return `<div class="entity vehicle"><span class="body"></span><span class="cab"></span><span class="wheel a"></span><span class="wheel b"></span></div>`;
    }
    return `<div class="entity plant"><span class="stem"></span><span class="leaf a"></span><span class="leaf b"></span><span class="leaf c"></span></div>`;
  }

  function renderBiome() {
    const wrap = $("#biome-view");
    if (!wrap) return;
    wrap.innerHTML = "";
    const invs = Data.all().slice().sort((a, b) => invMagnitude(b) - invMagnitude(a));
    const max = Math.max(...invs.map(invMagnitude), 1);
    invs.slice(0, 28).forEach((inv, idx) => {
      const value = invMagnitude(inv);
      const color = inv.Kind === "Debt" ? "var(--danger)" : colorFor(inv.Category || inv.Ticker);
      const shape = shapeFor(inv);
      const card = el("div", "entity-card");
      card.tabIndex = 0;
      card.setAttribute("role", "img");
      card.setAttribute("aria-label", `${positionLabel(inv)}, ${cleanTag(inv.Category)}, ${fmt$full(value)}${inv.Kind === "Debt" ? " owed" : ""}`);
      card.style.setProperty("--entity-color", color);
      card.style.setProperty("--tilt", (idx % 2 ? "-4deg" : "4deg"));
      card.innerHTML = `
        <div class="entity-card-lift">
          ${entityMarkup(shape)}
          <div class="entity-ground"></div>
          <div class="entity-label"><b>${inv.Ticker || "—"}</b><span>${fmt$(value)} · ${cleanTag(inv.Category)}</span></div>
        </div>`;
      card.querySelector(".entity").style.setProperty("--h", clamp(92 + Math.sqrt(value / max) * 148, 92, 240) + "px");
      card.addEventListener("pointerenter", () => card.classList.add("is-hovered"));
      card.addEventListener("mousemove", e =>
        showTip(`<b>${positionLabel(inv)}</b><br><span class="tt-k">${cleanTag(inv.Institution)} · ${cleanTag(inv["Account Type"])}</span><br>${fmt$full(value)}${inv.Kind === "Debt" ? " owed" : ""}<br><span class="tt-k">growth</span> ${fmtPct(inv["Nominal Rate"])}`, e.clientX, e.clientY));
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
      wrap.appendChild(card);
    });
    if (invs.length > 28) wrap.appendChild(el("div", "file-note", `Showing the 28 largest holdings · ${invs.length - 28} more in the ledger and charts below.`));
  }

  function renderConstellation() {
    const container = $("#constellation-view");
    if (!container) return;
    container.innerHTML = "";
    const invs = Data.all();
    if (!invs.length) { container.appendChild(el("div", "file-note", "No positions yet.")); return; }

    const W = 1080, H = 430, cx = W / 2, cy = H / 2;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "constellation-svg", role: "img", "aria-label": "Institution, account, and position constellation" });
    const insts = [...new Set(invs.map(i => cleanTag(i.Institution)))];
    const maxValue = Math.max(...invs.map(invMagnitude), 1);
    const instPos = new Map();
    const accountPos = new Map();
    const posById = new Map();

    insts.forEach((inst, i) => {
      const a = -Math.PI / 2 + (i / Math.max(insts.length, 1)) * Math.PI * 2;
      instPos.set(inst, { x: cx + Math.cos(a) * 285, y: cy + Math.sin(a) * 128, angle: a });
    });

    insts.forEach(inst => {
      const invForInst = invs.filter(inv => cleanTag(inv.Institution) === inst);
      const accounts = [...new Set(invForInst.map(i => cleanTag(i["Account Type"])))];
      const hub = instPos.get(inst);
      accounts.forEach((acct, j) => {
        const a = hub.angle + ((j - (accounts.length - 1) / 2) * .52);
        const pos = { x: hub.x + Math.cos(a) * 92, y: hub.y + Math.sin(a) * 62 };
        accountPos.set(inst + "|" + acct, pos);
      });
    });

    accountPos.forEach((pos, key) => {
      const inst = key.split("|")[0];
      const hub = instPos.get(inst);
      svg.appendChild(svgEl("line", { x1: hub.x, y1: hub.y, x2: pos.x, y2: pos.y, class: "const-link" }));
    });

    invs.forEach((inv, i) => {
      const inst = cleanTag(inv.Institution), acct = cleanTag(inv["Account Type"]);
      const anchor = accountPos.get(inst + "|" + acct) || instPos.get(inst) || { x: cx, y: cy };
      const siblings = invs.filter(x => cleanTag(x.Institution) === inst && cleanTag(x["Account Type"]) === acct);
      const idx = siblings.findIndex(x => x.ID === inv.ID);
      const a = (idx / Math.max(siblings.length, 1)) * Math.PI * 2 + i * .17;
      const dist = 42 + (idx % 4) * 15;
      const x = clamp(anchor.x + Math.cos(a) * dist, 30, W - 30);
      const y = clamp(anchor.y + Math.sin(a) * dist, 28, H - 28);
      svg.appendChild(svgEl("line", { x1: anchor.x, y1: anchor.y, x2: x, y2: y, class: `const-link${inv.Kind === "Debt" ? " debt" : ""}` }));
      posById.set(inv.ID, { x, y });
    });

    instPos.forEach((pos, inst) => {
      const value = invs.filter(i => cleanTag(i.Institution) === inst).reduce((s, i) => s + invMagnitude(i), 0);
      svg.appendChild(svgEl("circle", { cx: pos.x, cy: pos.y, r: clamp(22 + Math.sqrt(value / maxValue) * 22, 22, 54), class: "const-hub" }));
      const label = svgEl("text", { x: pos.x, y: pos.y + 4, "text-anchor": "middle", class: "const-label" });
      label.textContent = inst;
      svg.appendChild(label);
    });

    accountPos.forEach((pos, key) => {
      const acct = key.split("|")[1];
      svg.appendChild(svgEl("circle", { cx: pos.x, cy: pos.y, r: 14, class: "const-account" }));
      const label = svgEl("text", { x: pos.x, y: pos.y + 28, "text-anchor": "middle", class: "const-value" });
      label.textContent = acct;
      svg.appendChild(label);
    });

    invs.slice().sort((a, b) => invMagnitude(a) - invMagnitude(b)).forEach(inv => {
      const pos = posById.get(inv.ID);
      if (!pos) return;
      const value = invMagnitude(inv);
      const node = svgEl("circle", {
        cx: pos.x, cy: pos.y,
        r: clamp(5 + Math.sqrt(value / maxValue) * 26, 5, 31),
        fill: inv.Kind === "Debt" ? "var(--danger)" : colorFor(inv.Category || inv.Ticker),
        class: "const-node"
      });
      node.addEventListener("mousemove", e =>
        showTip(`<b>${positionLabel(inv)}</b><br>${cleanTag(inv.Institution)} · ${cleanTag(inv["Account Type"])}<br>${fmt$full(value)}${inv.Kind === "Debt" ? " owed" : ""}<br><span class="tt-k">${cleanTag(inv.Category)} · ${cleanTag(inv.Subcategory)}</span>`, e.clientX, e.clientY));
      node.addEventListener("mouseleave", hideTip);
      svg.appendChild(node);
      if (value / maxValue > .12) {
        const label = svgEl("text", { x: pos.x, y: pos.y - 12, "text-anchor": "middle", class: "const-label" });
        label.textContent = inv.Ticker || "#" + inv.ID;
        svg.appendChild(label);
      }
    });
    container.appendChild(svg);
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
      clear: () => { last = inp.value || last; inp.value = ""; on = false; apply(); }
    };
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
    $("#copy-select").addEventListener("change", e => Portfolios.switchTo(e.target.value));
    $("#copy-new").addEventListener("click", () => {
      const name = prompt("Name for the new portfolio", "Untitled");
      if (name === null) return;
      Portfolios.create(name);
      ui.contribTouched = false; ui.contribIds.clear();
      toast("New portfolio created");
    });
    $("#copy-dup").addEventListener("click", () => {
      Portfolios.duplicate();
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
      ui.contribTouched = false; ui.contribIds.clear();
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
    $("#monthly-out").textContent = (ui.contribTouched ? fmt$full(proj.contrib.total) + "/mo exact" : fmt$full(ui.monthly) + "/mo");
    const controlsSummary = $("#proj-controls-summary");
    if (controlsSummary) {
      controlsSummary.textContent = `${ui.years}Y · ${ui.contribTouched ? fmt$(proj.contrib.total) + "/mo exact" : fmt$(ui.monthly) + "/mo"} · ${proj.contrib.count} target${proj.contrib.count === 1 ? "" : "s"}${ui.taxOn ? " · post-tax" : ""}`;
    }
    renderContribChips(proj.contrib);
    renderStats(proj);
    renderHeroExperience(proj);
    renderBiome();
    renderConstellation();
    stackedArea($("#proj-chart"), proj);
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
    const years = $("#years-slider"), monthly = $("#monthly-slider");
    years.addEventListener("input", () => {
      ui.years = Number(years.value);
      $("#years-out").textContent = ui.years + " yrs";
      renderAll();
    });
    monthly.addEventListener("input", () => {
      ui.monthly = Number(monthly.value);
      $("#monthly-out").textContent = fmt$full(ui.monthly) + "/mo";
      renderAll();
    });
    document.querySelectorAll(".tax-toggle").forEach(t =>
      t.addEventListener("change", () => {
        ui.taxOn = t.checked;
        document.querySelectorAll(".tax-toggle").forEach(o => o.checked = ui.taxOn);
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

  function wireIO() {
    $("#copy-json").addEventListener("click", async () => {
      const backup = Data.toJSON();
      try {
        await navigator.clipboard.writeText(backup);
        toast("Backup copied to clipboard");
      } catch {
        const ta = document.createElement("textarea");
        ta.value = backup; document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); ta.remove();
        toast("Backup copied to clipboard");
      }
    });

    const fileInput = $("#file-input");
    document.querySelectorAll(".load-json").forEach(b => b.addEventListener("click", () => fileInput.click()));
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files[0];
      if (!file) return;
      try {
        Data.loadText(await file.text());
        ui.contribTouched = false; ui.contribIds.clear();
        toast(`Imported ${Data.all().length} positions`);
      } catch (err) { toast("Couldn't read that backup: " + err.message); }
      fileInput.value = "";
    });

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
      ui.contribTouched = false; ui.contribIds.clear();
      toast("Sample portfolio loaded");
    });
  }

  /* ---------- boot ---------- */

  wireControls();
  wireForm();
  wireIO();
  wireCopies();

  // Portfolios.init() restores the active copy from localStorage (seeding a
  // "Default" from tickers.json only on first run), then we subscribe the
  // renderer so it draws once against restored state.
  Portfolios.init().then(() => {
    Data.subscribe(renderAll);
    Data.subscribe(pulseSaved);   // subscribed after init, so boot's initial load doesn't pulse
    renderAll();
  });

})();
