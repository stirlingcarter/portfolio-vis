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

  const MONEY_MASK = "$•••";
  const AMOUNT_MASK = "••••";
  const moneyHidden = () => ui.privacyMode === true;
  const fmt$ = v => {
    if (moneyHidden()) return MONEY_MASK;
    const abs = Math.abs(v);
    if (abs >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
    if (abs >= 1e4) return "$" + (v / 1e3).toFixed(1) + "k";
    return "$" + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  };
  const fmt$full = v => moneyHidden() ? MONEY_MASK : "$" + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  // Full dollars-and-cents — used in the ledger where exact valuations matter.
  const fmt$cents = v => moneyHidden() ? MONEY_MASK : "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPct = v => (v * 100).toFixed(1) + "%";
  const fmtLeveragePct = v => Number.isFinite(v) ? fmtPct(v) : "∞%";
  const fmtMultiple = v => Number.isFinite(v) ? v.toFixed(v >= 10 ? 1 : 2) + "x" : "∞x";
  const clamp = (n, min, max) => Math.min(Math.max(n, min), max);
  const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

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
  const LEDGER_UNGROUPED = "__ungrouped__";
  // Table grouping follows the ledger's tag-like schema fields.
  const LEDGER_GROUP_DIMS = Data.TAG_DIMENSIONS.slice();
  const MAX_LEDGER_COPIES = Portfolios.maxLedgers ? Portfolios.maxLedgers() : 8;

  const NON_MARKET = new Set(["cash", "real estate", "loan", "mortgage", "debt"]);
  const fixedPriceForTicker = ticker => String(ticker || "").trim().toUpperCase() === "USD" ? 1 : null;
  function looksTradable(inv) {
    if (!inv || inv.Kind === "Debt") return false;
    if (NON_MARKET.has((inv.Category || "").trim().toLowerCase())) return false;
    return /^[A-Za-z][A-Za-z.\-]{0,6}$/.test((inv.Ticker || "").trim());
  }
  const shouldAutoPrice = inv => !!inv && (fixedPriceForTicker(inv.Ticker) != null || looksTradable(inv));
  const PRICE_REFRESH_THROTTLE_MS = 60 * 1000;

  /* ---------- ui state (presentation-only) ---------- */

  const ui = {
    theme: "dark",
    taxOn: false,
    years: 25,
    monthly: 1000,
    projectionView: "simple",
    projectionControlsOpen: false,
    simpleRate: 0.08,
    simpleMonthly: 0,
    simpleMonthlyEnabled: false,
    heroMetric: "net",
    biomeMode: "cards",
    privacyMode: false,
    contribIds: new Set(),
    contribAmounts: new Map(), // exact monthly dollars per selected position after user edits
    contribTouched: false,  // once the user picks targets, stop auto-selecting new ones
    floatPositions: new Map(), // saved free-floating terrarium positions by holding ID
    editingId: null,        // ledger row currently being edited in place (or null)
    ledgerSort: "ID",
    ledgerGroupBy: "Institution",
    lastPriceRefreshAt: 0,
    historyRange: "24h"     // holdings-history look-back (keys in Prices.HISTORY_RANGES)
  };

  const UI_STORAGE_KEY = "coldledger.ui.v1";
  const RANGE_LIMITS = {
    years: { min: 1, max: 50, step: 1, fallback: 25 },
    monthly: { min: 0, max: 10000, step: 100, fallback: 1000 },
    simpleRate: { min: -0.1, max: 0.5, step: 0.005, fallback: 0.08 },
    simpleMonthly: { min: 0, max: 1000000, step: "any", fallback: 0 }
  };
  const HERO_METRICS = [
    { key: "net", label: "net worth", value: () => Data.total(ui.taxOn) },
    { key: "assets", label: "assets", value: () => Data.assetTotal(ui.taxOn) },
    { key: "debt", label: "debt", value: () => Data.debtTotal(ui.taxOn) }
  ];
  // Coherent app themes — palettes live in styles.css under html[data-theme=…].
  // "dark" is the original petrol/brass identity and needs no attribute overrides.
  const THEMES = ["dark", "white", "sand", "pink"];
  const LIGHT_TOGGLE_THEME = "white";
  const coerceTheme = value => THEMES.includes(value) ? value : "dark";

  const BIOME_MODES = ["cards", "float", "pens"];
  const BIOME_MODE_META = {
    cards: {
      label: "card layout",
      note: "Holdings",
      aria: "Holdings"
    },
    float: {
      label: "free-floating garden",
      note: "Holdings",
      aria: "Holdings"
    },
    pens: {
      label: "institution pens",
      note: "Institutions",
      aria: "by institution"
    }
  };

  function heroMetricFor(key) {
    return HERO_METRICS.find(metric => metric.key === key) || HERO_METRICS[0];
  }

  function nextHeroMetricKey(key) {
    const idx = HERO_METRICS.findIndex(metric => metric.key === key);
    return HERO_METRICS[(idx + 1) % HERO_METRICS.length].key;
  }

  function heroColorForMetric(key) {
    if (key === "assets") return "var(--assets, var(--asset))";
    if (key === "debt") return "var(--debt, var(--danger))";
    return "var(--net, var(--net-worth, #a78bfa))";
  }

  function coerceBiomeMode(value) {
    if (BIOME_MODES.includes(value)) return value;
    if (value === "free" || value === "floating") return "float";
    if (value === "institution" || value === "institutions" || value === "inst" || value === "pen") return "pens";
    return "cards";
  }

  function coerceProjectionView(value) {
    return value === "detailed" || value === "simple" ? value : "simple";
  }

  function coerceProjectionControlsOpen(value) {
    return value === true;
  }

  function coerceLedgerGroupBy(value) {
    if (value === LEDGER_UNGROUPED) return LEDGER_UNGROUPED;
    return LEDGER_GROUP_DIMS.includes(value) ? value : "Institution";
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

  function effectiveSimpleMonthly() {
    ui.simpleMonthly = rangeValue(ui.simpleMonthly, RANGE_LIMITS.simpleMonthly);
    return ui.simpleMonthlyEnabled ? ui.simpleMonthly : 0;
  }

  function simpleMonthlyOutputText() {
    const configured = fmt$full(ui.simpleMonthly) + "/mo";
    return ui.simpleMonthlyEnabled ? configured : `${configured} saved`;
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

  function timestampValue(raw) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function formatEasternTime(ms) {
    const ts = timestampValue(ms);
    if (!ts) return "";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
        hour12: true
      }).format(new Date(ts)) + " ET";
    } catch {
      return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) + " ET";
    }
  }

  function priceRefreshStatusText(prefix) {
    const updated = ui.lastPriceRefreshAt
      ? `Updated at ${formatEasternTime(ui.lastPriceRefreshAt)}`
      : "Not updated yet";
    return prefix ? `${prefix} · ${updated}` : updated;
  }

  function updateLivePriceStatus(prefix = "") {
    const text = priceRefreshStatusText(prefix);
    document.querySelectorAll("[data-live-price-status]").forEach(node => {
      node.textContent = text;
      node.title = text;
    });
  }

  function shouldSkipPageLoadPriceRefresh(now = Date.now()) {
    const last = timestampValue(ui.lastPriceRefreshAt);
    const age = now - last;
    return last > 0 && Number.isFinite(age) && age >= 0 && age <= PRICE_REFRESH_THROTTLE_MS;
  }

  function markLivePriceRefreshSuccess(at = Date.now()) {
    ui.lastPriceRefreshAt = timestampValue(at);
    saveUiState();
    updateLivePriceStatus();
  }

  function activePortfolioId() {
    try { return Portfolios.activeId(); } catch { return null; }
  }

  function resetContributionState() {
    ui.contribTouched = false;
    ui.contribIds.clear();
    ui.contribAmounts.clear();
  }

  function resetFloatPositionState() {
    ui.floatPositions.clear();
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

  function serializeFloatPositionState() {
    const positions = {};
    ui.floatPositions.forEach((pos, id) => {
      const x = Number(pos && pos.x);
      const y = Number(pos && pos.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      positions[String(id)] = {
        x: Number(clamp(x, 0, 100).toFixed(2)),
        y: Number(clamp(y, 0, 100).toFixed(2))
      };
    });
    return positions;
  }

  function applyFloatPositionState(raw) {
    resetFloatPositionState();
    const positions = raw && typeof raw === "object" && raw.floatPositions && typeof raw.floatPositions === "object"
      ? raw.floatPositions
      : null;
    if (!positions) return;
    Object.entries(positions).forEach(([id, pos]) => {
      const nId = Number(id);
      const x = Number(pos && pos.x);
      const y = Number(pos && pos.y);
      if (!Number.isFinite(nId) || !Number.isFinite(x) || !Number.isFinite(y)) return;
      ui.floatPositions.set(nId, { x: clamp(x, 0, 100), y: clamp(y, 0, 100) });
    });
  }

  function pruneFloatPositions(liveIds) {
    let changed = false;
    [...ui.floatPositions.keys()].forEach(id => {
      if (!liveIds.has(id)) {
        ui.floatPositions.delete(id);
        changed = true;
      }
    });
    return changed;
  }

  function loadStoredProjectionState() {
    const state = readUiStorage();
    const projection = state.projection;
    if (projection && typeof projection === "object") {
      if ("years" in projection) ui.years = rangeValue(projection.years, RANGE_LIMITS.years);
      if ("monthly" in projection) ui.monthly = rangeValue(projection.monthly, RANGE_LIMITS.monthly);
      if ("taxOn" in projection) ui.taxOn = projection.taxOn === true;
      if ("projectionView" in projection) ui.projectionView = coerceProjectionView(projection.projectionView);
      if ("projectionControlsOpen" in projection) ui.projectionControlsOpen = coerceProjectionControlsOpen(projection.projectionControlsOpen);
      if ("simpleRate" in projection) ui.simpleRate = rangeValue(projection.simpleRate, RANGE_LIMITS.simpleRate);
      if ("simpleMonthly" in projection) ui.simpleMonthly = rangeValue(projection.simpleMonthly, RANGE_LIMITS.simpleMonthly);
      ui.simpleMonthlyEnabled = "simpleMonthlyEnabled" in projection
        ? projection.simpleMonthlyEnabled === true
        : ui.simpleMonthly > 0;
    }
    if ("heroMetric" in state) ui.heroMetric = heroMetricFor(state.heroMetric).key;
    if ("historyRange" in state) ui.historyRange = coerceHistoryRange(state.historyRange);
    if ("biomeMode" in state) ui.biomeMode = coerceBiomeMode(state.biomeMode);
    if ("privacyMode" in state) ui.privacyMode = state.privacyMode === true;
    if ("lastPriceRefreshAt" in state) ui.lastPriceRefreshAt = timestampValue(state.lastPriceRefreshAt);
    if ("theme" in state) ui.theme = coerceTheme(state.theme);
  }

  function loadActivePortfolioUiState() {
    const state = readUiStorage();
    const activeId = activePortfolioId();
    const byPortfolio = state.portfolios && typeof state.portfolios === "object" ? state.portfolios : {};
    const portfolioState = activeId ? byPortfolio[activeId] : null;
    applyContributionState(portfolioState);
    applyFloatPositionState(portfolioState);
  }

  function saveUiState() {
    const state = readUiStorage();
    const next = {
      version: 1,
      projection: {
        years: rangeValue(ui.years, RANGE_LIMITS.years),
        monthly: rangeValue(ui.monthly, RANGE_LIMITS.monthly),
        taxOn: ui.taxOn === true,
        projectionView: coerceProjectionView(ui.projectionView),
        projectionControlsOpen: coerceProjectionControlsOpen(ui.projectionControlsOpen),
        simpleRate: rangeValue(ui.simpleRate, RANGE_LIMITS.simpleRate),
        simpleMonthly: rangeValue(ui.simpleMonthly, RANGE_LIMITS.simpleMonthly),
        simpleMonthlyEnabled: ui.simpleMonthlyEnabled === true
      },
      heroMetric: heroMetricFor(ui.heroMetric).key,
      historyRange: coerceHistoryRange(ui.historyRange),
      biomeMode: coerceBiomeMode(ui.biomeMode),
      theme: coerceTheme(ui.theme),
      privacyMode: ui.privacyMode === true,
      lastPriceRefreshAt: timestampValue(ui.lastPriceRefreshAt),
      portfolios: state.portfolios && typeof state.portfolios === "object" ? { ...state.portfolios } : {}
    };
    const activeId = activePortfolioId();
    if (activeId) {
      next.portfolios[activeId] = {
        ...serializeContributionState(),
        floatPositions: serializeFloatPositionState()
      };
    }
    writeUiStorage(next);
  }

  function syncProjectionControlsToDom() {
    const years = $("#years-slider"), monthly = $("#monthly-slider"), simpleRate = $("#simple-rate-slider");
    const simpleMonthly = $("#simple-monthly-input"), simpleMonthlyEnabled = $("#simple-monthly-enabled");
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
    if (simpleMonthly) {
      simpleMonthly.min = String(RANGE_LIMITS.simpleMonthly.min);
      simpleMonthly.max = String(RANGE_LIMITS.simpleMonthly.max);
      simpleMonthly.step = String(RANGE_LIMITS.simpleMonthly.step);
      ui.simpleMonthly = rangeValue(ui.simpleMonthly, RANGE_LIMITS.simpleMonthly);
      simpleMonthly.value = moneyHidden() ? "" : String(ui.simpleMonthly);
      simpleMonthly.placeholder = moneyHidden() ? MONEY_MASK : "$/mo";
      simpleMonthly.disabled = moneyHidden();
      simpleMonthly.title = moneyHidden()
        ? "Turn off privacy mode to edit this simple monthly contribution"
        : "Saved monthly amount for the Simple projection; use the toggle to apply it";
      const out = $("#simple-monthly-out");
      if (out) out.textContent = simpleMonthlyOutputText();
    }
    if (simpleMonthlyEnabled) {
      simpleMonthlyEnabled.checked = ui.simpleMonthlyEnabled;
      const label = $("#simple-monthly-enabled-label");
      if (label) label.textContent = ui.simpleMonthlyEnabled ? "On" : "Off";
      const block = simpleMonthlyEnabled.closest(".simple-monthly-block");
      if (block) block.classList.toggle("is-disabled", !ui.simpleMonthlyEnabled);
    }
    document.querySelectorAll(".tax-toggle").forEach(t => { t.checked = ui.taxOn; });
    syncPrivacyControlToDom();
    syncThemeToDom();
    syncProjectionControlsOpenToDom();
    syncProjectionModeToDom();
    syncBiomeModeToDom();
  }

  function syncProjectionControlsOpenToDom() {
    const panel = $(".proj-controls-panel");
    if (panel) panel.open = coerceProjectionControlsOpen(ui.projectionControlsOpen);
  }

  function syncThemeToDom() {
    ui.theme = coerceTheme(ui.theme);
    if (ui.theme === "dark") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = ui.theme;

    const btn = $("#theme-mode-toggle");
    if (!btn) return;
    const isDark = ui.theme === "dark";
    btn.setAttribute("aria-pressed", String(isDark));
    btn.title = isDark ? "Switch to light theme" : "Switch to dark theme";
    btn.setAttribute("aria-label", isDark
      ? "Dark mode on. Switch to light theme."
      : "Dark mode off. Switch to dark theme.");
  }

  function syncProjectionModeToDom() {
    ui.projectionView = coerceProjectionView(ui.projectionView);
    const simple = ui.projectionView === "simple";
    const section = $("#projection");
    if (section) section.classList.toggle("is-simple", simple);
    const detailedBtn = $("#proj-view-detailed");
    const simpleBtn = $("#proj-view-simple");
    if (detailedBtn) detailedBtn.setAttribute("aria-pressed", String(!simple));
    if (simpleBtn) simpleBtn.setAttribute("aria-pressed", String(simple));
    const note = $("#projection-mode-note");
    if (note) note.textContent = simple
      ? "aggregate assets/debt"
      : "hover for detail";
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

  function syncPrivacyControlToDom() {
    const on = moneyHidden();
    document.documentElement.toggleAttribute("data-privacy", on);
    const btn = $("#privacy-toggle");
    if (!btn) return;
    btn.setAttribute("aria-pressed", String(on));
    btn.title = on ? "Show monetary amounts" : "Hide monetary amounts";
    btn.setAttribute("aria-label", on
      ? "Privacy mode on. Show monetary amounts."
      : "Privacy mode off. Hide monetary amounts.");
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

  // The hero title is just the number: net worth (white), assets (green) or
  // debt (red), always to the cent. Clicking it cycles between the three.
  function heroDerivedAmounts(metricKey, base) {
    const yearly = metricKey === "debt"
      ? base * Data.debtWeightedRate(ui.taxOn)
      : base * 0.05 * 0.93;
    return { yearly, monthly: yearly / 12 };
  }

  function cycleHeroMetric() {
    ui.heroMetric = nextHeroMetricKey(ui.heroMetric);
    saveUiState();
    renderAll();
  }

  function renderPlanetMetricEcho(metric, next, value, amount) {
    const echo = $("#planet-metric-echo");
    if (!echo) return;
    echo.innerHTML = "";

    const taxContext = ui.taxOn ? " · post-tax" : "";
    const btn = el("button", `planet-amount-echo is-${metric.key}`, amount);
    btn.type = "button";
    btn.title = `Earth focus: ${metric.label}${taxContext} — click to show ${next.label}`;
    btn.setAttribute("aria-label", `Earth focus ${metric.label}: ${amount}${ui.taxOn ? " post-tax" : ""}. Activate to show ${next.label}.`);
    btn.addEventListener("click", cycleHeroMetric);

    echo.append(
      el("span", "planet-metric-kicker", `${metric.label}${taxContext}`),
      btn
    );
  }

  function renderHeroAmount() {
    const title = $("#hero-title");
    if (!title) return;
    const metric = heroMetricFor(ui.heroMetric);
    const next = heroMetricFor(nextHeroMetricKey(metric.key));
    const value = metric.value();
    const amount = fmt$cents(value);
    title.innerHTML = "";
    const btn = el("button", `hero-amount is-${metric.key}`, amount);
    btn.type = "button";
    btn.title = `${metric.label}${ui.taxOn ? " · post-tax" : ""} — click to show ${next.label}`;
    btn.setAttribute("aria-label", `${metric.label}: ${amount}${ui.taxOn ? " post-tax" : ""}. Activate to show ${next.label}.`);
    btn.addEventListener("click", cycleHeroMetric);
    title.appendChild(btn);
    const derived = $("#hero-derived");
    if (derived) {
      const values = heroDerivedAmounts(metric.key, value);
      derived.innerHTML = "";
      derived.append(
        el("span", "", fmt$cents(values.yearly)),
        el("span", "", fmt$cents(values.monthly))
      );
    }
    renderPlanetMetricEcho(metric, next, value, amount);
  }

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

  /* ---------- invested-assets pie chart ---------- */

  function donut(container, title, groups, totalLabel) {
    const card = el("div", "panel donut-card");
    const displayTotal = groups.reduce((s, g) => s + g.value, 0);
    const groupColor = g => g.color || colorFor(g.colorKey || g.label);
    const head = el("div", "donut-card-head");
    head.appendChild(el("h3", null, title));
    head.appendChild(el("div", "donut-total", `<b>${fmt$(displayTotal)}</b><span>${totalLabel}</span>`));
    card.appendChild(head);
    const body = el("div", "donut-body");

    const size = 150, viewH = 166, cx = size / 2, cy = 74, rOut = 64, depth = 12;
    const svg = svgEl("svg", {
      viewBox: `0 0 ${size} ${viewH}`,
      class: "donut-svg pie-can-svg",
      width: size,
      height: viewH,
      role: "img",
      "aria-label": `${title}: ${fmt$full(displayTotal)} ${totalLabel}`
    });
    const total = displayTotal || 1;

    const polar = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    svg.appendChild(svgEl("ellipse", { cx, cy: cy + depth + rOut * .72, rx: rOut * .82, ry: 13, class: "pie-can-shadow" }));
    const depthGroup = svgEl("g", { class: "pie-depth-group", transform: `translate(0 ${depth})` });
    const topGroup = svgEl("g", { class: "pie-top-group" });
    let angle = -Math.PI / 2;
    groups.forEach(g => {
      const frac = g.value / total;
      const gap = groups.length > 1 ? 0.018 : 0;
      const sweep = Math.max(frac * Math.PI * 2 - gap * 2, 0.005);
      const a0 = angle + gap, a1 = angle + gap + sweep;
      angle += frac * Math.PI * 2;
      const large = sweep > Math.PI ? 1 : 0;
      const [x0o, y0o] = polar(rOut, a0), [x1o, y1o] = polar(rOut, a1);
      const d = `M ${cx} ${cy} L ${x0o} ${y0o} A ${rOut} ${rOut} 0 ${large} 1 ${x1o} ${y1o} Z`;
      const depthPath = svgEl("path", {
        d,
        fill: groupColor(g),
        class: "pie-depth"
      });
      const path = svgEl("path", {
        d,
        fill: groupColor(g),
        class: "donut-seg pie-seg"
      });
      const showSliceTip = e =>
        showTip(`<b>${g.label}</b><br><span class="tt-k">value</span> ${fmt$full(g.value)}<br><span class="tt-k">share</span> ${fmtPct(g.value / total)} · ${g.count} position${g.count > 1 ? "s" : ""}`, e.clientX, e.clientY);
      [depthPath, path].forEach(slice => {
        slice.addEventListener("mousemove", showSliceTip);
        slice.addEventListener("mouseleave", hideTip);
      });
      depthGroup.appendChild(depthPath);
      topGroup.appendChild(path);
    });
    if (groups.length === 0) {
      topGroup.appendChild(svgEl("circle", { cx, cy, r: rOut, class: "pie-empty" }));
    }
    svg.appendChild(depthGroup);
    svg.appendChild(topGroup);
    body.appendChild(svg);

    const legend = el("div", "legend");
    groups.slice(0, 8).forEach(g => {
      const row = el("div", "legend-row");
      const sw = el("span", "swatch"); sw.style.background = groupColor(g);
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
    const W = 1080, H = 540, padL = 76, padR = 24, padT = 30, padB = 46;
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
      z.textContent = fmt$(0);
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
        "stroke-width": s.contributing ? 2.35 : 1.3
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
    netLabel.textContent = `Net worth ${fmt$(netEnd)}${netEnd < yMin ? ` (below ${fmt$(0)})` : ""}`;
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
    const W = 1080, H = 520, padL = 76, padR = 34, padT = 34, padB = 50;
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

  function hBars(container, groups, opts = {}) {
    container.innerHTML = "";
    if (groups.length === 0) {
      container.appendChild(el("div", "file-note", "No positions yet."));
      return;
    }
    const denominator = opts.denominator > 0
      ? opts.denominator
      : Math.max(...groups.map(g => g.value), 1);
    const denominatorLabel = opts.denominatorLabel || "largest row";
    if (opts.showDenominator !== false) {
      const note = el("div", "bar-denominator-note");
      note.textContent = `Each full track = ${denominatorLabel} (${fmt$full(denominator)}).`;
      container.appendChild(note);
    }
    groups.forEach(g => {
      const frac = denominator > 0 ? clamp(g.value / denominator, 0, 1) : 0;
      const color = colorFor(g.colorKey || g.label);
      const row = el("div", "bar-row");
      const lbl = el("span", "b-lbl", g.label);
      lbl.title = g.label;
      row.appendChild(lbl);
      const track = el("div", "bar-track");
      track.setAttribute("aria-label", `${g.label}: ${fmtPct(frac)} of ${denominatorLabel}`);
      const fill = el("div", "bar-fill");
      fill.style.width = (frac * 100).toFixed(1) + "%";
      fill.style.background = color;
      fill.style.color = color;
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el("span", "b-val", `${fmtPct(frac)} · ${fmt$(g.value)}`));
      row.addEventListener("mousemove", e =>
        showTip(`<b>${g.label}</b><br><span class="tt-k">value</span> ${fmt$full(g.value)}<br><span class="tt-k">share</span> ${fmtPct(frac)} of ${denominatorLabel}`, e.clientX, e.clientY));
      row.addEventListener("mouseleave", hideTip);
      container.appendChild(row);
    });
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

  function institutionAccountBars(container, xtab, denominator) {
    const groups = [];
    xtab.rows.forEach(institution => {
      xtab.cols.forEach(account => {
        const value = xtab.cells[institution][account] || 0;
        if (value <= 0) return;
        groups.push({
          label: `${institution} · ${account}`,
          value,
          colorKey: account
        });
      });
    });
    groups.sort((a, b) => b.value - a.value);
    hBars(container, groups, {
      denominator,
      denominatorLabel: "total invested assets"
    });
  }

  function assetDebtChart(container, assets, debts) {
    const assetValue = Math.max(assets, 0);
    const debtValue = Math.max(debts, 0);
    const rows = Data.all();
    donut(container, "Assets vs debt", [
      { label: "Assets", value: assetValue, count: rows.filter(Data.isAsset).length, color: "var(--asset)" },
      { label: "Debt", value: debtValue, count: rows.filter(Data.isDebt).length, color: "var(--danger)" }
    ], "assets + debt");
  }

  /* ---------- spatial 2026 visualizations ---------- */

  const cleanTag = v => String(v || "—").trim() || "—";
  const ledgerGroupLabel = v => String(v ?? "").trim() || "Unlabeled";
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
  function institutionPenLayoutFor(inst, max) {
    const holdings = inst.holdings && inst.holdings.length ? inst.holdings : [];
    const count = Math.max(holdings.length || inst.count || 0, 1);
    const sizes = holdings.map(inv => penEntitySizeFor(invMagnitude(inv), max));
    const largest = Math.max(...sizes, 50);

    if (count === 1) {
      return {
        kind: "single",
        span: 1,
        width: Math.round(clamp(largest * 1.28 + 54, 132, 198)),
        minHeight: Math.round(clamp(largest + 108, 166, 220)),
        cardMinHeight: Math.round(clamp(largest + 76, 126, 180)),
        yardMin: Math.round(clamp(largest * .78 + 36, 74, 124))
      };
    }

    const columns = clamp(Math.ceil(Math.sqrt(count * 1.35)), 2, 4);
    const rows = Math.ceil(count / columns);
    const span = clamp(columns + (largest > 92 ? 1 : 0), 2, 5);
    return {
      kind: "multi",
      span,
      minHeight: Math.round(clamp(86 + rows * 154, 220, 560)),
      cardMinHeight: 148,
      yardMin: 74
    };
  }
  function floatEdgesFor(size, bounds) {
    const width = bounds && bounds.width ? bounds.width : FLOAT_STAGE.w;
    const height = bounds && bounds.height ? bounds.height : FLOAT_STAGE.h;
    return {
      x: clamp((size * .48 / width) * 100, 5, 18),
      y: clamp((size * .58 / height) * 100, 8, 24)
    };
  }

  function clampFloatPosition(x, y, size, bounds) {
    const edges = floatEdgesFor(size, bounds);
    const rawX = Number.isFinite(Number(x)) ? Number(x) : 50;
    const rawY = Number.isFinite(Number(y)) ? Number(y) : 50;
    return {
      x: Number(clamp(rawX, edges.x, 100 - edges.x).toFixed(2)),
      y: Number(clamp(rawY, edges.y, 100 - edges.y).toFixed(2))
    };
  }

  function saveFloatPosition(id, x, y, size, bounds) {
    const nId = Number(id);
    if (!Number.isFinite(nId)) return;
    ui.floatPositions.set(nId, clampFloatPosition(x, y, size, bounds));
    saveUiState();
  }

  function applyStoredFloatPositions(layout, invs) {
    let changed = false;
    invs.forEach(inv => {
      const saved = ui.floatPositions.get(inv.ID);
      const pos = layout.get(inv.ID);
      if (!saved || !pos) return;
      const clamped = clampFloatPosition(saved.x, saved.y, pos.size);
      if (clamped.x !== saved.x || clamped.y !== saved.y) {
        ui.floatPositions.set(inv.ID, clamped);
        changed = true;
      }
      layout.set(inv.ID, { ...pos, x: clamped.x, y: clamped.y });
    });
    return changed;
  }

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

  function renderHeroExperience() {
    const stage = $("#hero-visual");
    if (!stage) return;

    const invs = Data.all();
    stage.innerHTML = "";
    const orbit = el("div", "hero-orbit");
    const heroMetric = heroMetricFor(ui.heroMetric);
    orbit.dataset.metric = heroMetric.key;
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

    const heroMetricValue = heroMetric.value();
    const nextHeroMetric = heroMetricFor(nextHeroMetricKey(heroMetric.key));
    const taxContext = ui.taxOn ? " · post-tax" : "";
    const core = el("button", "hero-core earth-core", `<span class="earth-atmosphere" aria-hidden="true"></span><span class="earth-clouds" aria-hidden="true"></span>`);
    core.type = "button";
    core.title = `Earth view: showing ${heroMetric.label}${taxContext}. Click to show ${nextHeroMetric.label}.`;
    core.style.setProperty("--hero-amount-color", heroColorForMetric(heroMetric.key));
    core.setAttribute("aria-label", `Showing ${heroMetric.label}: ${fmt$full(heroMetricValue)}${ui.taxOn ? " post-tax" : ""}. Activate to show ${nextHeroMetric.label}.`);
    core.addEventListener("click", cycleHeroMetric);
    orbit.appendChild(core);

    const max = Math.max(...invs.map(invMagnitude), 1);
    invs.slice().sort((a, b) => invMagnitude(b) - invMagnitude(a)).slice(0, 18).forEach((inv, i, arr) => {
      const nodeMetric = inv.Kind === "Debt" ? "debt" : "assets";
      const highlighted = heroMetric.key === "net" || heroMetric.key === nodeMetric;
      const n = el("span", [
        "orbit-node",
        nodeMetric === "debt" ? "debt" : "asset",
        highlighted ? "is-highlighted" : "is-dimmed"
      ].join(" "));
      const value = invMagnitude(inv);
      const angle = (i / Math.max(arr.length, 1)) * 360 + (i % 2 ? 10 : -5);
      const dist = 132 + (i % 3) * 32;
      const size = clamp(12 + Math.sqrt(value / max) * 34, 12, 46);
      n.style.setProperty("--angle", angle + "deg");
      n.style.setProperty("--dist", dist + "px");
      n.style.setProperty("--size", size + "px");
      n.style.setProperty("--c", heroColorForMetric(nodeMetric));
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

  function wireFloatDrag(card, wrap, holdingId) {
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
      const edges = floatEdgesFor(start.size, bounds);

      const move = moveEvent => {
        const nextX = start.x + ((moveEvent.clientX - start.clientX) / bounds.width) * 100;
        const nextY = start.y + ((moveEvent.clientY - start.clientY) / bounds.height) * 100;
        card.style.setProperty("--float-x", clamp(nextX, edges.x, 100 - edges.x).toFixed(2) + "%");
        card.style.setProperty("--float-y", clamp(nextY, edges.y, 100 - edges.y).toFixed(2) + "%");
      };
      const stop = stopEvent => {
        card.classList.remove("is-dragging");
        if (card.hasPointerCapture(stopEvent.pointerId)) card.releasePointerCapture(stopEvent.pointerId);
        card.removeEventListener("pointermove", move);
        card.removeEventListener("pointerup", stop);
        card.removeEventListener("pointercancel", stop);
        saveFloatPosition(
          holdingId,
          parseFloat(card.style.getPropertyValue("--float-x")),
          parseFloat(card.style.getPropertyValue("--float-y")),
          start.size,
          bounds
        );
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
      card.title = "Drag with a mouse to reposition. Position is saved for this portfolio.";
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
    if (floating && opts.wrap) wireFloatDrag(card, opts.wrap, inv.ID);
    return card;
  }

  function renderBiomePens(wrap, invs, max, totalCount) {
    const groups = institutionGroups(invs);
    groups.forEach(inst => {
      const penLayout = institutionPenLayoutFor(inst, max);
      const pen = el("section", `institution-pen is-${penLayout.kind}`);
      pen.setAttribute("aria-label", `${inst.name} pen, net ${fmt$full(inst.netValue)}, ${inst.count} position${inst.count === 1 ? "" : "s"}`);
      pen.style.setProperty("--pen-span", String(penLayout.span));
      pen.style.setProperty("--pen-min-height", penLayout.minHeight + "px");
      pen.style.setProperty("--pen-card-min-height", penLayout.cardMinHeight + "px");
      pen.style.setProperty("--pen-yard-min", penLayout.yardMin + "px");
      if (penLayout.width) pen.style.setProperty("--pen-width", penLayout.width + "px");
      const head = el("div", "institution-pen-head");
      const title = el("h3", "institution-pen-title", inst.name);
      title.title = inst.name;
      head.appendChild(title);
      head.appendChild(el("span", "institution-pen-meta", `${fmt$(inst.netValue)} net · ${inst.count} pos`));
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
    const liveIds = new Set(invs.map(inv => inv.ID));
    let floatStateChanged = pruneFloatPositions(liveIds);
    const floatLayout = floating ? floatLayoutFor(visibleInvs, max) : new Map();
    if (floating) floatStateChanged = applyStoredFloatPositions(floatLayout, visibleInvs) || floatStateChanged;
    if (floatStateChanged) saveUiState();
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
        groups.set(instName, { name: instName, value: 0, assetValue: 0, debtValue: 0, netValue: 0, count: 0, accounts: new Map(), holdings: [] });
      }
      const inst = groups.get(instName);
      if (!inst.accounts.has(acctName)) inst.accounts.set(acctName, { name: acctName, value: 0, assetValue: 0, debtValue: 0, netValue: 0, count: 0 });
      const acct = inst.accounts.get(acctName);
      const isDebt = inv.Kind === "Debt";
      inst.value += value;
      inst.assetValue += isDebt ? 0 : value;
      inst.debtValue += isDebt ? value : 0;
      inst.netValue += isDebt ? -value : value;
      inst.count += 1;
      inst.holdings.push(inv);
      acct.value += value;
      acct.assetValue += isDebt ? 0 : value;
      acct.debtValue += isDebt ? value : 0;
      acct.netValue += isDebt ? -value : value;
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
        <th class="num">Shares / Amount</th><th class="num">Price</th><th class="num">Value</th><th class="num">Rate</th><th class="num">Tax</th><th>Amort</th><th></th>
      </tr>
    </thead>`;

  function ledgerSortValue(inv) {
    if (ui.ledgerSort === "ID") return Number(inv.ID) || 0;
    return cleanTag(inv[ui.ledgerSort]).toLocaleLowerCase();
  }

  function sortedLedgerRows(rows) {
    return rows.slice().sort((a, b) => {
      const av = ledgerSortValue(a), bv = ledgerSortValue(b);
      let cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
      if (cmp === 0) cmp = Number(a.ID) - Number(b.ID);
      return cmp;
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

  function ledgerSummary(rows) {
    return rows.reduce((summary, inv) => {
      const value = Math.abs(Number(Data.presentValue(inv, false)) || 0);
      if (Data.isDebt(inv)) summary.debts += value;
      else summary.assets += value;
      return summary;
    }, { assets: 0, debts: 0 });
  }

  function ledgerSummaryText(rows) {
    const { assets, debts } = ledgerSummary(rows);
    const net = assets - debts;
    const count = rows.length;
    return `Assets ${fmt$full(assets)} · Debts ${fmt$full(debts)} · Net ${fmt$full(net)} · ${count} position${count === 1 ? "" : "s"}`;
  }

  function ledgerGroupBlock(label, rows) {
    const group = el("div", "ledger-group");
    const head = el("div", "ledger-group-head");
    head.appendChild(el("h3", null, label));
    head.appendChild(el("span", null, ledgerSummaryText(rows)));
    group.appendChild(head);
    group.appendChild(ledgerTable(sortedLedgerRows(rows)));
    return group;
  }

  function renderGroupedLedger(wrap, rows, dimension) {
    const groupBy = coerceLedgerGroupBy(dimension);
    const groups = new Map();
    rows.forEach(inv => {
      const label = ledgerGroupLabel(inv[groupBy]);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(inv);
    });
    [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })).forEach(label => {
      const groupRows = groups.get(label);
      wrap.appendChild(ledgerGroupBlock(label, groupRows));
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

  let activeInlineEditor = null;

  const INLINE_CELL_LABELS = {
    "Ticker": "ticker",
    "Institution": "institution",
    "Account Type": "account type",
    "Kind": "kind",
    "Category": "vehicle",
    "Subcategory": "vehicle category",
    "Amount": "shares",
    "Price": "price per share",
    "Value": "value",
    "Nominal Rate": "nominal rate",
    "Nominal tax rate": "nominal tax rate",
    "Amort": "amortization"
  };

  function inlineCellLabel(field, inv) {
    return field === "Amount" && inv && inv.Kind === "Debt"
      ? "amount"
      : (INLINE_CELL_LABELS[field] || field);
  }

  function amountEditUpdate(inv, amount) {
    const update = { "Amount": amount };
    if (inv.Kind === "Debt") {
      update["Value"] = amount;
      return update;
    }
    const fixed = fixedPriceForTicker(inv.Ticker);
    const pps = Data.pricePerShare(inv);
    if (fixed != null) update["Value"] = amount * fixed;
    else if (pps !== "") update["Value"] = amount * Number(pps);
    return update;
  }

  function finiteInlineNumber(input, label, opts = {}) {
    const raw = String(input.value ?? "").trim();
    if (raw === "") {
      if (opts.allowBlank) return { ok: true, value: "" };
      toast(`Enter ${label}`);
      return { ok: false };
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      toast(`Enter a valid ${label}`);
      return { ok: false };
    }
    if (opts.min != null && value < opts.min) {
      toast(`${label[0].toUpperCase() + label.slice(1)} must be ${opts.min} or more`);
      return { ok: false };
    }
    if (opts.positive && value <= 0) {
      toast(`${label[0].toUpperCase() + label.slice(1)} must be greater than 0`);
      return { ok: false };
    }
    return { ok: true, value };
  }

  function optionalInlineNumber(input, label, opts = {}) {
    if (input.disabled || String(input.value ?? "").trim() === "") return true;
    return finiteInlineNumber(input, label, opts).ok;
  }

  function wrapInlineControl(control, cls) {
    const wrap = el("span", cls || "inline-cell-editor");
    wrap.appendChild(control);
    return wrap;
  }

  function createInlineInput(value, attrs = {}) {
    const inputEl = el("input");
    inputEl.value = value ?? "";
    Object.entries(attrs).forEach(([key, val]) => {
      if (val != null) inputEl.setAttribute(key, val);
    });
    return inputEl;
  }

  function createLedgerInlineEditor(inv, config) {
    const field = config.field;
    const label = inlineCellLabel(field, inv);
    const textField = (value, attrs, read) => {
      const inputEl = createInlineInput(value, { type: "text", ...attrs });
      return {
        node: wrapInlineControl(inputEl),
        focusEl: inputEl,
        commit: () => read(inputEl)
      };
    };
    const numberField = (value, attrs, read) => {
      const inputEl = createInlineInput(value, { type: "number", ...attrs });
      return {
        node: wrapInlineControl(inputEl),
        focusEl: inputEl,
        commit: () => read(inputEl)
      };
    };

    if (field === "Ticker") {
      return textField(inv.Ticker, {}, inputEl => {
        const ticker = inputEl.value.trim().toUpperCase();
        if (!ticker) { toast("Ticker is required"); return false; }
        const update = { "Ticker": ticker };
        const fixed = fixedPriceForTicker(ticker);
        if (fixed != null) update["Value"] = Number(inv.Amount) * fixed;
        Data.update(inv.ID, update);
        return true;
      });
    }

    if (field === "Institution" || field === "Account Type" || field === "Category" || field === "Subcategory") {
      const list = field === "Account Type" ? "dl-Account-Type" : `dl-${field}`;
      return textField(inv[field], { list }, inputEl => {
        Data.update(inv.ID, { [field]: inputEl.value });
        return true;
      });
    }

    if (field === "Kind") {
      const select = el("select");
      Data.KINDS.forEach(kind => {
        const option = el("option");
        option.value = kind;
        option.textContent = kind;
        if (inv.Kind === kind) option.selected = true;
        select.appendChild(option);
      });
      return {
        node: wrapInlineControl(select),
        focusEl: select,
        commitOnChange: true,
        commit: () => {
          Data.update(inv.ID, { "Kind": select.value });
          return true;
        }
      };
    }

    if (field === "Amount") {
      return numberField(inv.Amount, { step: "any", min: "0" }, inputEl => {
        const parsed = finiteInlineNumber(inputEl, label, { positive: true });
        if (!parsed.ok) return false;
        Data.update(inv.ID, amountEditUpdate(inv, parsed.value));
        return true;
      });
    }

    if (field === "Price") {
      const pps = Data.pricePerShare(inv);
      return numberField(pps === "" ? "" : +pps.toFixed(6), { step: "any", min: "0", placeholder: "$/share" }, inputEl => {
        const parsed = finiteInlineNumber(inputEl, label, { min: 0, allowBlank: true });
        if (!parsed.ok) return false;
        const fixed = fixedPriceForTicker(inv.Ticker);
        if (fixed != null) {
          Data.update(inv.ID, { "Value": Number(inv.Amount) * fixed });
          return true;
        }
        if (parsed.value === "") {
          Data.update(inv.ID, { "Value": "" });
          return true;
        }
        Data.update(inv.ID, { "Value": Number(inv.Amount) * parsed.value });
        return true;
      });
    }

    if (field === "Value") {
      return numberField(inv.Value === "" ? "" : inv.Value, { step: "any", min: "0", placeholder: "unpriced" }, inputEl => {
        const parsed = finiteInlineNumber(inputEl, label, { min: 0, allowBlank: true });
        if (!parsed.ok) return false;
        const fixed = fixedPriceForTicker(inv.Ticker);
        Data.update(inv.ID, { "Value": fixed == null ? parsed.value : Number(inv.Amount) * fixed });
        return true;
      });
    }

    if (field === "Nominal Rate") {
      return numberField(inv["Nominal Rate"], { step: "0.005" }, inputEl => {
        const parsed = finiteInlineNumber(inputEl, label);
        if (!parsed.ok) return false;
        Data.update(inv.ID, { "Nominal Rate": parsed.value });
        return true;
      });
    }

    if (field === "Nominal tax rate") {
      const tax = removableRate(inv["Nominal tax rate"]);
      return {
        node: wrapInlineControl(tax.wrap),
        focusEl: tax.input,
        commit: () => {
          if (!optionalInlineNumber(tax.input, label, { min: 0 })) return false;
          Data.update(inv.ID, { "Nominal tax rate": tax.read() });
          return true;
        }
      };
    }

    if (field === "Amort" && inv.Kind === "Debt") {
      const amMonths = removableNumber(inv["Amort Months"], {
        step: "1", min: "0", placeholder: "mo",
        removeTitle: "Remove months left", addTitle: "Add months left"
      });
      const amPay = removableNumber(inv["Amort Payment"], {
        step: "any", min: "0", placeholder: "$/mo",
        removeTitle: "Remove monthly payment", addTitle: "Add monthly payment"
      });
      const amortWrap = el("span", "amort-field");
      amortWrap.appendChild(amMonths.wrap);
      amortWrap.appendChild(amPay.wrap);
      wireAutoAmortPayment({
        kindInput: { value: "Debt", addEventListener: () => {} },
        monthsInput: amMonths.input,
        paymentControl: amPay,
        paymentInput: amPay.input,
        dependencyInputs: [],
        principal: () => Math.abs(Data.presentValue(inv, false)),
        annualRate: () => Number(inv["Nominal Rate"]) || 0
      });
      return {
        node: wrapInlineControl(amortWrap, "inline-cell-editor inline-amort-editor"),
        focusEl: amMonths.input,
        commit: () => {
          if (!optionalInlineNumber(amMonths.input, "amortization months", { min: 0 })) return false;
          if (!optionalInlineNumber(amPay.input, "amortization payment", { min: 0 })) return false;
          Data.update(inv.ID, {
            "Amort Months": amMonths.read(),
            "Amort Payment": amPay.read()
          });
          return true;
        }
      };
    }

    return null;
  }

  function startLedgerCellEdit(td, inv, config) {
    if (ui.editingId != null) return;
    if (activeInlineEditor && !activeInlineEditor.cell.isConnected) activeInlineEditor = null;
    if (activeInlineEditor) {
      if (activeInlineEditor.cell === td) return;
      activeInlineEditor.commit();
      if (!td.isConnected) return;
    }

    const editor = createLedgerInlineEditor(inv, config);
    if (!editor) return;

    const original = td.innerHTML;
    td.innerHTML = "";
    td.classList.add("inline-editing");
    td.appendChild(editor.node);

    let done = false;
    const restore = () => {
      td.innerHTML = original;
      td.classList.remove("inline-editing", "inline-invalid");
    };
    const finish = save => {
      if (done) return;
      if (save) {
        td.classList.remove("inline-invalid");
        if (!editor.commit()) {
          td.classList.add("inline-invalid");
          if (editor.focusEl) {
            editor.focusEl.focus();
            if (typeof editor.focusEl.select === "function") editor.focusEl.select();
          }
          return;
        }
      } else {
        restore();
      }
      done = true;
      activeInlineEditor = null;
    };
    activeInlineEditor = { cell: td, commit: () => finish(true), cancel: () => finish(false) };

    editor.node.addEventListener("click", e => e.stopPropagation());
    editor.node.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter" && e.target.tagName !== "BUTTON") {
        e.preventDefault();
        finish(true);
      }
    });
    editor.node.addEventListener("focusout", () => {
      setTimeout(() => {
        if (!done && !editor.node.contains(document.activeElement)) finish(true);
      }, 0);
    });
    if (editor.commitOnChange) {
      editor.focusEl.addEventListener("change", () => finish(true));
    }
    setTimeout(() => {
      if (editor.focusEl) {
        editor.focusEl.focus();
        if (typeof editor.focusEl.select === "function") editor.focusEl.select();
      }
    }, 0);
  }

  function makeLedgerCellEditable(td, inv, config) {
    if (!td) return;
    const label = inlineCellLabel(config.field, inv);
    td.classList.add("ledger-editable-cell");
    td.dataset.editField = config.field;
    td.tabIndex = 0;
    td.setAttribute("role", "button");
    td.setAttribute("aria-label", `Edit ${label} for ${positionLabel(inv)}`);
    td.title = `Click to edit ${label}`;
    td.addEventListener("click", () => startLedgerCellEdit(td, inv, config));
    td.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " " || e.key === "F2") {
        e.preventDefault();
        startLedgerCellEdit(td, inv, config);
      }
    });
  }

  // A read-only ledger row, with Edit / remove actions.
  function displayRow(inv) {
    const tr = el("tr");
    const debt = inv.Kind === "Debt";
    const kindPill = `<span class="tag-pill ${debt ? "kind-debt" : "kind-asset"}">${inv.Kind}</span>`;
    const valMag = Data.presentValue(inv, false);
    const valCell = inv.Value === ""
      ? `<span style="color:var(--faint)" title="unpriced — using fallback valuation">${fmt$cents(debt ? -valMag : valMag)}*</span>`
      : (debt ? `<span class="kind-debt">−${fmt$cents(valMag)}</span>` : fmt$cents(inv.Value));
    const pps = Data.pricePerShare(inv);
    const priceCell = pps === "" ? `<span style="color:var(--faint)">—</span>` : fmt$cents(pps);
    const amountCell = moneyHidden()
      ? AMOUNT_MASK
      : inv.Amount.toLocaleString(undefined, { maximumFractionDigits: 4 });
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
      <td class="num">${amountCell}</td>
      <td class="num">${priceCell}</td>
      <td class="num">${valCell}</td>
      <td class="num">${fmtPct(inv["Nominal Rate"])}</td>
      <td class="num">${taxCell}</td>
      <td>${amortCell}</td>
      <td class="row-actions"></td>`;
    const editableFields = [
      [1, "Ticker"],
      [2, "Institution"],
      [3, "Account Type"],
      [4, "Kind"],
      [5, "Category"],
      [6, "Subcategory"],
      [7, "Amount"],
      [8, "Price"],
      [9, "Value"],
      [10, "Nominal Rate"],
      [11, "Nominal tax rate"]
    ];
    editableFields
      .filter(([, field]) => !moneyHidden() || (field !== "Amount" && field !== "Price" && field !== "Value"))
      .forEach(([idx, field]) => makeLedgerCellEditable(tr.children[idx], inv, { field }));
    if (debt && !moneyHidden()) makeLedgerCellEditable(tr.children[12], inv, { field: "Amort" });
    const edit = el("button", "edit-btn", "edit");
    if (moneyHidden()) {
      edit.disabled = true;
      edit.title = "Turn off privacy mode to use the full row editor";
    } else {
      edit.addEventListener("click", () => { ui.editingId = inv.ID; renderAll(); });
    }
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
    ui.ledgerGroupBy = coerceLedgerGroupBy(ui.ledgerGroupBy);
    const groupSelect = $("#ledger-group-by");
    if (groupSelect && groupSelect.value !== ui.ledgerGroupBy) groupSelect.value = ui.ledgerGroupBy;
    if (ui.ledgerGroupBy !== LEDGER_UNGROUPED) renderGroupedLedger(wrap, rows, ui.ledgerGroupBy);
    else wrap.appendChild(ledgerGroupBlock("All positions", rows));
    $("#ledger-empty").style.display = rows.length ? "none" : "block";
    wrap.style.display = rows.length ? "" : "none";
    if (controls) controls.style.display = rows.length ? "" : "none";
  }

  /* ---------- portfolio ledger tabs ---------- */

  const ledgerTabId = id => `ledger-tab-${id}`;
  const ledgerCountText = count => `${count} position${count === 1 ? "" : "s"}`;
  const ledgerLimitMessage = () => `Maximum of ${MAX_LEDGER_COPIES} ledgers reached`;
  const canCreateLedger = () => Portfolios.list().length < MAX_LEDGER_COPIES;

  function switchToLedger(id) {
    if (!id || id === Portfolios.activeId()) return;
    saveUiState();
    ui.editingId = null;
    activeInlineEditor = null;
    Portfolios.switchTo(id);
    loadActivePortfolioUiState();
    syncProjectionControlsToDom();
    renderAll();
  }

  function createLedgerFromPrompt() {
    if (!canCreateLedger()) {
      toast(ledgerLimitMessage());
      return;
    }
    const name = prompt("Name for the new ledger", "Untitled");
    if (name === null) return;
    saveUiState();
    const created = Portfolios.create(name);
    if (!created) {
      toast(ledgerLimitMessage());
      return;
    }
    resetContributionState();
    resetFloatPositionState();
    saveUiState();
    renderAll();
    toast("New ledger created");
  }

  function beginLedgerRename(tab, copy) {
    if (!copy || !copy.active || tab.classList.contains("is-renaming")) return;
    const label = tab.querySelector(".ledger-tab-label");
    if (!label) return;
    const input = el("input", "ledger-tab-rename-input");
    input.type = "text";
    input.value = copy.name;
    input.maxLength = 48;
    input.setAttribute("aria-label", "Rename current ledger");
    input.setAttribute("autocomplete", "off");

    let done = false;
    const finish = commit => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (commit && next && next !== copy.name) {
        Portfolios.rename(copy.id, next);
        toast("Renamed");
      }
      renderCopyBar();
    };

    input.addEventListener("click", e => e.stopPropagation());
    input.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));

    tab.classList.add("is-renaming");
    label.replaceWith(input);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  function wireLedgerTabKeyboard(tab) {
    tab.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        tab.click();
        return;
      }
      const tabs = [...tab.parentElement.querySelectorAll('[role="tab"]')];
      const current = tabs.indexOf(tab);
      if (current < 0) return;
      let next = current;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (current + 1) % tabs.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (current - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      else return;
      e.preventDefault();
      tabs[next].focus();
    });
  }

  const ledgerDuplicateIcon = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="8" y="8" width="10" height="10" rx="2"/>
      <path d="M6 14H5.5A2.5 2.5 0 0 1 3 11.5v-6A2.5 2.5 0 0 1 5.5 3h6A2.5 2.5 0 0 1 14 5.5V6"/>
    </svg>`;
  const ledgerDeleteIcon = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 7h14"/>
      <path d="M10 11v6"/>
      <path d="M14 11v6"/>
      <path d="M8 7l1-3h6l1 3"/>
      <path d="M7 7l1 13h8l1-13"/>
    </svg>`;

  function duplicateActiveLedger() {
    if (!canCreateLedger()) {
      toast(ledgerLimitMessage());
      return;
    }
    const contributionState = serializeContributionState();
    const floatPositions = serializeFloatPositionState();
    saveUiState();
    const duplicated = Portfolios.duplicate();
    if (!duplicated) {
      toast(ledgerLimitMessage());
      return;
    }
    applyContributionState(contributionState);
    applyFloatPositionState({ floatPositions });
    saveUiState();
    renderAll();
    toast(`Duplicated → "${Portfolios.activeName()}"`);
  }

  function deleteActiveLedger() {
    if (!confirm(`Delete "${Portfolios.activeName()}"? This can't be undone.`)) return;
    Portfolios.remove(Portfolios.activeId());
    loadActivePortfolioUiState();
    syncProjectionControlsToDom();
    saveUiState();
    renderAll();
    toast("Portfolio deleted");
  }

  function ledgerTabActionButton({ id, className = "", label, title, icon, disabled, onClick }) {
    const button = el("button", `ledger-tab-action-icon ${className}`.trim(), icon);
    button.id = id;
    button.type = "button";
    button.title = title;
    button.disabled = !!disabled;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-disabled", disabled ? "true" : "false");
    button.addEventListener("click", e => {
      e.stopPropagation();
      if (!disabled) onClick();
    });
    button.addEventListener("keydown", e => e.stopPropagation());
    return button;
  }

  function renderCopyBar() {
    const tabs = $("#ledger-tabs");
    if (!tabs) return;
    tabs.innerHTML = "";
    const copies = Portfolios.list();
    const active = copies.find(c => c.active);
    const panel = $("#ledger-tab-panel");
    const context = $("#settings-active-portfolio");
    if (context) {
      context.textContent = active
        ? `${active.name} · ${ledgerCountText(active.count)}`
        : "";
    }

    copies.forEach(c => {
      const tab = el("div", `ledger-tab${c.active ? " is-active" : ""}`);
      tab.id = ledgerTabId(c.id);
      tab.dataset.copyId = c.id;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", c.active ? "true" : "false");
      tab.setAttribute("aria-controls", "ledger-tab-panel");
      tab.tabIndex = c.active ? 0 : -1;
      tab.title = c.active
        ? `${c.name} · ${ledgerCountText(c.count)} · click title to rename`
        : `${c.name} · ${ledgerCountText(c.count)}`;
      tab.addEventListener("click", () => {
        if (!c.active) switchToLedger(c.id);
      });
      wireLedgerTabKeyboard(tab);

      const tabContent = el("span", "ledger-tab-main");
      const label = el("span", "ledger-tab-label");
      label.textContent = c.name;
      if (c.active) {
        label.classList.add("is-rename-target");
        label.title = "Click to rename this ledger";
        label.addEventListener("click", e => {
          e.stopPropagation();
          beginLedgerRename(tab, c);
        });
      }
      const meta = el("span", "ledger-tab-meta");
      meta.textContent = ledgerCountText(c.count);
      tabContent.appendChild(label);
      tabContent.appendChild(meta);
      tab.appendChild(tabContent);
      if (c.active) {
        const maxed = copies.length >= MAX_LEDGER_COPIES;
        const deleteDisabled = copies.length <= 1 && Data.all().length === 0;
        const actions = el("span", "ledger-tab-actions");
        actions.setAttribute("role", "group");
        actions.setAttribute("aria-label", "Active ledger actions");
        actions.appendChild(ledgerTabActionButton({
          id: "copy-dup",
          label: maxed ? ledgerLimitMessage() : `Duplicate "${c.name}" ledger`,
          title: maxed ? ledgerLimitMessage() : "Duplicate this ledger",
          icon: ledgerDuplicateIcon,
          disabled: maxed,
          onClick: duplicateActiveLedger
        }));
        actions.appendChild(ledgerTabActionButton({
          id: "copy-del",
          className: "ledger-tab-delete ghost-danger",
          label: deleteDisabled ? "Cannot delete the only empty ledger" : `Delete "${c.name}" ledger`,
          title: deleteDisabled ? "Cannot delete the only empty ledger" : "Delete this ledger",
          icon: ledgerDeleteIcon,
          disabled: deleteDisabled,
          onClick: deleteActiveLedger
        }));
        tab.appendChild(actions);
      }
      tabs.appendChild(tab);
    });

    const canAdd = copies.length < MAX_LEDGER_COPIES;
    const add = el("div", `ledger-tab ledger-tab-add${canAdd ? "" : " is-disabled"}`);
    add.id = "ledger-tab-add";
    add.setAttribute("role", "tab");
    add.setAttribute("aria-selected", "false");
    add.setAttribute("aria-controls", "ledger-tab-panel");
    add.setAttribute("aria-label", canAdd ? "Create a new ledger" : ledgerLimitMessage());
    add.setAttribute("aria-disabled", canAdd ? "false" : "true");
    add.title = canAdd ? "Create a new ledger" : ledgerLimitMessage();
    add.tabIndex = active || !canAdd ? -1 : 0;
    add.innerHTML = `<span aria-hidden="true">(+)</span><span class="ledger-tab-meta">${canAdd ? "New ledger" : "Max 8 ledgers"}</span>`;
    add.addEventListener("click", () => {
      if (canAdd) createLedgerFromPrompt();
      else toast(ledgerLimitMessage());
    });
    if (canAdd) wireLedgerTabKeyboard(add);
    tabs.appendChild(add);

    if (panel && active) panel.setAttribute("aria-labelledby", ledgerTabId(active.id));
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
      amtInput.value = !moneyHidden() && on ? +exact.toFixed(2) : "";
      amtInput.placeholder = moneyHidden() ? MONEY_MASK : "$/mo";
      amtInput.disabled = moneyHidden() || !on;
      amtInput.setAttribute("aria-label", `Monthly contribution for ${positionLabel(inv)}`);
      amtInput.title = moneyHidden()
        ? "Turn off privacy mode to edit this monthly contribution"
        : on ? "Exact monthly contribution for this position" : "Turn this position on to edit its contribution";
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

  function renderStats(proj, aggregateProj) {
    const statTotal = $("#stat-total");
    const statTotalSub = $("#stat-total-sub");
    const statCount = $("#stat-count");
    const statCountSub = $("#stat-count-sub");
    const statRate = $("#stat-rate");
    const statProj = $("#stat-proj");
    const statProjK = $("#stat-proj-k");
    if (!statTotal || !statTotalSub || !statCount || !statCountSub || !statRate || !statProj || !statProjK) return;

    const invs = Data.all();
    const assets = Data.assetTotal(ui.taxOn), debts = Data.debtTotal(ui.taxOn);
    const projected = ui.projectionView === "simple" && aggregateProj
      ? aggregateProj.assets[aggregateProj.assets.length - 1] - aggregateProj.debts[aggregateProj.debts.length - 1]
      : proj.totals[proj.totals.length - 1];
    statTotal.textContent = fmt$full(Data.total(ui.taxOn));
    statTotalSub.textContent = debts > 0
      ? `${fmt$(assets)} assets − ${fmt$(debts)} debts`
      : (ui.taxOn ? "after nominal withdrawal tax" : "pre-tax basis");
    statCount.textContent = invs.length;
    statCountSub.textContent =
      new Set(invs.map(i => i.Institution || "—")).size + " institutions · " +
      new Set(invs.map(i => i["Account Type"] || "—")).size + " account types";
    statRate.textContent = fmtPct(Data.weightedRate());
    statProj.textContent = fmt$(projected);
    statProjK.textContent = `Projected · ${ui.years}Y`;
  }

  function renderProjectionReadout(proj) {
    const end = proj.totals[proj.totals.length - 1];
    const { perTarget, count, total } = proj.contrib;
    const contributed = total * 12 * ui.years;
    const principal = Data.total(false);
    const growth = Math.max(end - principal - contributed, 0);
    const splitTxt = count > 0 && ui.contribTouched
      ? `<span class="hl"><b>${fmt$full(total)}</b>/mo exact → <b>${count}</b> position${count === 1 ? "" : "s"}</span>`
      : count > 0
      ? `<span class="hl">${fmt$full(ui.monthly)}/mo → <b>${count}</b> position${count === 1 ? "" : "s"} · <b>${fmt$full(perTarget)}</b> each</span>`
      : `<span>no contribution targets selected</span>`;
    const summary = $("#proj-readout-summary");
    if (summary) summary.textContent = `Detailed · ${ui.years}Y · end ${fmt$(end)} · growth ${fmt$(growth)}`;
    $("#proj-readout").innerHTML = `
      ${splitTxt}
      <span>end value <b>${fmt$full(end)}</b></span>
      <span>principal <b>${fmt$full(principal)}</b></span>
      <span>contributed <b>${fmt$full(contributed)}</b></span>
      <span>growth <b>${fmt$full(growth)}</b></span>
      <span>${ui.taxOn ? "post-tax · " : ""}rates are real (inflation baked in)</span>`;
  }

  function renderAggregateProjectionReadout(proj) {
    const N = proj.months.length - 1;
    const startAssets = proj.assets[0];
    const startDebts = proj.debts[0];
    const endAssets = proj.assets[N];
    const endDebts = proj.debts[N];
    const endNet = endAssets - endDebts;
    const contributed = proj.contribution.monthly * 12 * ui.years;
    const contributionSummary = ui.simpleMonthlyEnabled
      ? `<span class="hl"><b>${fmt$full(proj.contribution.monthly)}</b>/mo simple contribution</span>`
      : `<span class="hl">simple contribution off · <b>${fmt$full(ui.simpleMonthly)}</b>/mo saved</span>`;
    const summary = $("#proj-readout-summary");
    if (summary) summary.textContent = `Simple · ${ui.years}Y · end net ${fmt$(endNet)} · ${fmtPct(proj.rate)}/yr`;
    $("#proj-readout").innerHTML = `
      <span class="hl"><b>${fmtPct(proj.rate)}</b>/yr aggregate rate</span>
      ${contributionSummary}
      <span>assets <b>${fmt$full(startAssets)}</b> → <b>${fmt$full(endAssets)}</b></span>
      <span>debt <b>${fmt$full(startDebts)}</b> → <b>${fmt$full(endDebts)}</b></span>
      <span>end net <b>${fmt$full(endNet)}</b></span>
      <span>contributed <b>${fmt$full(contributed)}</b></span>
      <span>${ui.taxOn ? "post-tax · " : ""}debt shown as positive balance</span>
      <span>${proj.debt.amortized ? `${proj.debt.amortized} amortizing debt${proj.debt.amortized === 1 ? "" : "s"} follow schedules outside the contribution budget` : "no scheduled debt paydown"}${proj.debt.carried ? ` · ${proj.debt.carried} carried at aggregate rate` : ""}</span>`;
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

  /* ---------- holdings history (Robinhood-style look-back) ----------
     Current auto-priced asset holdings, valued at PAST prices: one smooth
     line of shares × price(t) summed per ticker over the selected look-back.
     Price series come from Prices.historyMany and are cached per
     (ticker, range) in localStorage so range flips and reloads reuse data.

     Phase model: every rendered point comes from the same cached snapshot —
     the chart's "now" is the OLDEST fetchedAt among the series in use, so the
     whole line shifts together as one coherent phase instead of each ticker
     demanding its own exact-Now fetch. Staleness is bounded per range by
     Prices.HISTORY_RANGES[].ttlMs.
  ------------------------------------ */

  const HISTORY_STORAGE_KEY = "coldledger.history.v1";
  const HISTORY_CACHE_MAX_ENTRIES = 120;      // ~tickers × ranges, pruned oldest-first
  const HISTORY_CACHE_MAX_AGE_MS = 14 * 86400e3;
  const HISTORY_STORED_POINTS = 160;          // per-series cap kept in localStorage
  const HISTORY_GRID_POINTS = 120;            // rendered portfolio-line resolution
  const HISTORY_RETRY_MS = 10 * 60e3;         // wait before retrying a failed ticker
  const HISTORY_Y_DOMAIN_PADDING_RATIO = .65; // extra scale room compresses visual swings
  const HISTORY_Y_DOMAIN_MIN_PADDING_RATIO = .02;
  const HISTORY_Y_DOMAIN_MIN_PADDING = 1;
  // Robinhood-style: the line bleeds to both edges and there are no axes, so
  // the plot has no horizontal padding and only a sliver of vertical headroom.
  const HISTORY_CHART_GEOMETRY = Object.freeze({
    width: 1080,
    height: 340,
    padLeft: 0,
    padRight: 0,
    padTop: 18,
    padBottom: 6
  });
  const HISTORY_PLOT_BOTTOM_FADE_PX = 34;
  const HISTORY_PLOT_BOTTOM_FADE_MIN_OPACITY = .05;
  const HISTORY_PLOT_MASK_BLEED_PX = 8;

  function coerceHistoryRange(value) {
    return Prices.HISTORY_RANGES.some(r => r.key === value) ? value : "24h";
  }
  const historyRangeSpec = () => Prices.HISTORY_RANGES.find(r => r.key === coerceHistoryRange(ui.historyRange));
  const historyCacheKey = (sym, rangeKey) => `${sym}|${rangeKey}`;
  // The hero history intentionally tracks market-priced asset holdings only.
  // Net worth appears in the hero/balance sheet/projection, where debts subtract.
  const isHistoryHolding = inv => Data.isAsset(inv) && shouldAutoPrice(inv);

  function readHistoryStorage() {
    try {
      const parsed = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || "{}");
      return parsed && typeof parsed === "object" && parsed.series && typeof parsed.series === "object"
        ? { series: parsed.series }
        : { series: {} };
    } catch {
      return { series: {} };
    }
  }

  const historyCache = readHistoryStorage();
  const historyFailures = new Map();   // `${sym}|${range}` → { at, message } (session-only)
  let historyFetchKey = null;          // dedupe identical in-flight fetches

  function downsampleHistoryPoints(points) {
    if (points.length <= HISTORY_STORED_POINTS) return points;
    const step = (points.length - 1) / (HISTORY_STORED_POINTS - 1);
    return Array.from({ length: HISTORY_STORED_POINTS }, (_, i) => points[Math.round(i * step)]);
  }

  function pruneAndWriteHistoryCache() {
    const now = Date.now();
    const entries = Object.entries(historyCache.series)
      .filter(([, e]) => e && Array.isArray(e.points) && now - e.fetchedAt < HISTORY_CACHE_MAX_AGE_MS)
      .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
      .slice(0, HISTORY_CACHE_MAX_ENTRIES);
    historyCache.series = Object.fromEntries(entries);
    try { localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({ version: 1, series: historyCache.series })); }
    catch { /* quota / privacy mode — cache stays in memory */ }
  }

  function freshHistoryEntry(sym, spec) {
    const entry = historyCache.series[historyCacheKey(sym, spec.key)];
    return entry && Array.isArray(entry.points) && entry.points.length >= 2
      && Date.now() - entry.fetchedAt < spec.ttlMs ? entry : null;
  }

  // Unique fetchable tickers among current auto-priced asset holdings (USD is
  // synthesized locally as flat $1 and never fetched).
  function historyTickers() {
    const syms = new Set();
    Data.all().filter(isHistoryHolding).forEach(inv => {
      const sym = String(inv.Ticker || "").trim().toUpperCase();
      if (sym && fixedPriceForTicker(sym) == null) syms.add(sym);
    });
    return [...syms];
  }

  // Fetch any series that are missing or past TTL for the active range, then
  // re-render. A few results per graph: one request per ticker per range, and
  // failures are not retried for HISTORY_RETRY_MS so errors can't thrash.
  async function ensureHistorySeries() {
    const spec = historyRangeSpec();
    const now = Date.now();
    const missing = historyTickers().filter(sym => {
      if (freshHistoryEntry(sym, spec)) return false;
      const failure = historyFailures.get(historyCacheKey(sym, spec.key));
      return !(failure && now - failure.at < HISTORY_RETRY_MS);
    });
    if (!missing.length) return;
    const key = spec.key + "|" + missing.sort().join(",");
    if (historyFetchKey === key) return;
    historyFetchKey = key;
    setHistoryStatus(`Loading ${spec.label} price history for ${missing.length} ticker${missing.length === 1 ? "" : "s"}…`);
    try {
      const { results, errors } = await Prices.historyMany(missing, spec.key);
      results.forEach((h, sym) => {
        historyCache.series[historyCacheKey(sym, spec.key)] = {
          points: downsampleHistoryPoints(h.points),
          fetchedAt: h.fetchedAt,
          source: h.source
        };
        historyFailures.delete(historyCacheKey(sym, spec.key));
      });
      errors.forEach((err, sym) => {
        historyFailures.set(historyCacheKey(sym, spec.key), { at: Date.now(), message: err && err.message || "no data" });
      });
      if (results.size) pruneAndWriteHistoryCache();
    } finally {
      if (historyFetchKey === key) historyFetchKey = null;
    }
    renderHistorySection();
  }

  function setHistoryStatus(text) {
    const node = $("#history-status");
    if (node) {
      node.textContent = text || "";
      node.style.display = text ? "" : "none";
    }
  }

  function renderHistoryRangeChips(spec) {
    const wrap = $("#history-ranges");
    if (!wrap) return;
    wrap.innerHTML = "";
    Prices.HISTORY_RANGES.forEach(r => {
      const btn = el("button", "history-range-btn", r.label);
      btn.type = "button";
      btn.setAttribute("aria-pressed", String(r.key === spec.key));
      btn.title = `Look back ${r.label}`;
      btn.addEventListener("click", () => {
        if (ui.historyRange === r.key) return;
        ui.historyRange = r.key;
        saveUiState();
        renderHistorySection();
      });
      wrap.appendChild(btn);
    });
  }

  function fmtHistoryTime(ms, spec, withTime) {
    const d = new Date(ms);
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (spec.ms <= 24 * 3600e3) return time;
    if (spec.ms <= 14 * 86400e3) return withTime ? `${day} ${time}` : day;
    if (spec.ms <= 400 * 86400e3) return day;
    return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  }

  // Catmull-Rom → cubic bezier: the single smooth line.
  function smoothLinePath(pts) {
    if (pts.length < 2) return "";
    if (pts.length === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;
    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      d += ` C ${(p1.x + (p2.x - p0.x) / 6).toFixed(1)} ${(p1.y + (p2.y - p0.y) / 6).toFixed(1)},`
        + ` ${(p2.x - (p3.x - p1.x) / 6).toFixed(1)} ${(p2.y - (p3.y - p1.y) / 6).toFixed(1)},`
        + ` ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    }
    return d;
  }

  function historyValueDomain(values) {
    const lo = Math.min(...values), hi = Math.max(...values);
    const range = Math.max(0, hi - lo);
    const scale = Math.max(Math.abs(lo), Math.abs(hi), 1);
    const pad = Math.max(
      range * HISTORY_Y_DOMAIN_PADDING_RATIO,
      scale * HISTORY_Y_DOMAIN_MIN_PADDING_RATIO,
      HISTORY_Y_DOMAIN_MIN_PADDING
    );
    const allPositiveMoney = lo >= 0;
    return {
      yLo: allPositiveMoney ? Math.max(0, lo - pad) : lo - pad,
      yHi: hi + pad
    };
  }

  function drawHistoryChart(container, series, spec) {
    container.innerHTML = "";
    const {
      width: W,
      height: H,
      padLeft: padL,
      padRight: padR,
      padTop: padT,
      padBottom: padB
    } = HISTORY_CHART_GEOMETRY;
    const plotBottom = H - padB;
    const iw = W - padL - padR, ih = plotBottom - padT;
    const { times, values } = series;
    const N = values.length - 1;

    const { yLo, yHi } = historyValueDomain(values);
    const x = i => padL + (i / N) * iw;
    const y = v => padT + ih - ((v - yLo) / (yHi - yLo)) * ih;
    const up = values[N] >= values[0];
    const dir = up ? "is-up" : "is-down";

    const svg = svgEl("svg", {
      viewBox: `0 0 ${W} ${H}`, class: "chart-svg history-chart-svg", role: "img",
      "aria-label": `Auto-priced asset holdings value over the past ${spec.label}`
    });
    const gradientId = "history-plot-bottom-fade";
    const maskId = "history-plot-mask";
    const defs = svgEl("defs", {});
    const fadeStart = Math.max(padT, plotBottom - HISTORY_PLOT_BOTTOM_FADE_PX);
    const fadeStartOffset = ((fadeStart - padT) / ih * 100).toFixed(3) + "%";
    const gradient = svgEl("linearGradient", {
      id: gradientId,
      x1: 0,
      y1: padT,
      x2: 0,
      y2: plotBottom,
      gradientUnits: "userSpaceOnUse"
    });
    gradient.appendChild(svgEl("stop", { offset: "0%", "stop-color": "#fff", "stop-opacity": 1 }));
    gradient.appendChild(svgEl("stop", { offset: fadeStartOffset, "stop-color": "#fff", "stop-opacity": 1 }));
    gradient.appendChild(svgEl("stop", { offset: "100%", "stop-color": "#fff", "stop-opacity": HISTORY_PLOT_BOTTOM_FADE_MIN_OPACITY }));
    defs.appendChild(gradient);
    const mask = svgEl("mask", {
      id: maskId,
      x: padL - HISTORY_PLOT_MASK_BLEED_PX,
      y: padT - HISTORY_PLOT_MASK_BLEED_PX,
      width: iw + HISTORY_PLOT_MASK_BLEED_PX * 2,
      height: ih + HISTORY_PLOT_MASK_BLEED_PX,
      maskUnits: "userSpaceOnUse"
    });
    mask.appendChild(svgEl("rect", {
      x: padL - HISTORY_PLOT_MASK_BLEED_PX,
      y: padT - HISTORY_PLOT_MASK_BLEED_PX,
      width: iw + HISTORY_PLOT_MASK_BLEED_PX * 2,
      height: ih + HISTORY_PLOT_MASK_BLEED_PX,
      fill: `url(#${gradientId})`
    }));
    defs.appendChild(mask);
    svg.appendChild(defs);

    const plotLayer = svgEl("g", { class: "history-plot-layer", mask: `url(#${maskId})` });
    svg.appendChild(plotLayer);

    // Robinhood-style: no y-axis labels, no grid lines, no x-axis time labels.
    // Values and times surface only through scrubbing the line.

    // Dotted reference at the range-start value — Robinhood's "prior close" cue.
    plotLayer.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: y(values[0]), y2: y(values[0]), class: "history-baseline" }));

    const pts = values.map((v, i) => ({ x: x(i), y: y(v) }));
    const lineD = smoothLinePath(pts);
    plotLayer.appendChild(svgEl("path", {
      d: `${lineD} L ${x(N).toFixed(1)} ${plotBottom.toFixed(1)} L ${x(0).toFixed(1)} ${plotBottom.toFixed(1)} Z`,
      class: `history-area ${dir}`
    }));
    // non-scaling-stroke keeps the line a constant screen-pixel thickness:
    // without it the 1080-unit viewBox squeezes the stroke sub-pixel on phones.
    plotLayer.appendChild(svgEl("path", { d: lineD, fill: "none", "vector-effect": "non-scaling-stroke", class: `history-line ${dir}` }));
    plotLayer.appendChild(svgEl("circle", { cx: x(N), cy: y(values[N]), r: 4, class: `history-dot ${dir}` }));

    const cross = svgEl("line", { x1: 0, x2: 0, y1: padT, y2: plotBottom, class: "crosshair-line", opacity: 0 });
    const marker = svgEl("circle", { cx: 0, cy: 0, r: 3.5, class: `history-dot ${dir}`, opacity: 0 });
    plotLayer.appendChild(cross);
    plotLayer.appendChild(marker);

    const scrubTo = (clientX, clientY) => {
      const rect = svg.getBoundingClientRect();
      const mx = (clientX - rect.left) / rect.width * W;
      const i = Math.round(clamp((mx - padL) / iw, 0, 1) * N);
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i));
      cross.setAttribute("opacity", 1);
      marker.setAttribute("cx", x(i)); marker.setAttribute("cy", y(values[i]));
      marker.setAttribute("opacity", 1);
      const delta = values[i] - values[0];
      const pct = values[0] ? delta / values[0] : 0;
      showTip(
        `<b>${fmtHistoryTime(times[i], spec, true)}</b><br>` +
        `<span class="tt-k">asset holdings</span> ${fmt$full(values[i])}<br>` +
        `<span class="tt-k">vs start</span> ${delta >= 0 ? "+" : "−"}${fmt$(Math.abs(delta))} · ${(pct * 100).toFixed(2)}%`,
        clientX, clientY);
    };
    const endScrub = () => {
      cross.setAttribute("opacity", 0);
      marker.setAttribute("opacity", 0);
      hideTip();
    };

    // Robinhood-style scrubbing: one continuous press-and-drag slides across
    // the series (no lift-and-tap needed). Pointer capture keeps a touch drag
    // tracking even when the finger wanders off the SVG; `touch-action: none`
    // (set in CSS) stops the page from scrolling out from under the gesture.
    // Mouse users still get plain hover scrubbing via pointermove.
    svg.addEventListener("pointerdown", e => {
      if (e.pointerType !== "mouse") {
        try { svg.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
      }
      e.preventDefault();
      scrubTo(e.clientX, e.clientY);
    });
    svg.addEventListener("pointermove", e => scrubTo(e.clientX, e.clientY));
    svg.addEventListener("pointerup", e => { if (e.pointerType !== "mouse") endScrub(); });
    svg.addEventListener("pointercancel", endScrub);
    svg.addEventListener("pointerleave", endScrub);

    container.appendChild(svg);
  }

  function renderHistoryReadout(series, spec, asOf) {
    const wrap = $("#history-readout");
    if (!wrap) return;
    const { values } = series;
    const last = values[values.length - 1];
    const delta = last - values[0];
    const pct = values[0] ? delta / values[0] : 0;
    const dir = delta >= 0 ? "is-up" : "is-down";
    const stale = Date.now() - asOf > 90e3;
    wrap.innerHTML = `
      <span class="history-value">${fmt$cents(last)}</span>
      <span class="history-delta ${dir}">${delta >= 0 ? "▲" : "▼"} ${fmt$(Math.abs(delta))} · ${(pct * 100).toFixed(2)}% <em>past ${spec.label}</em></span>
      ${stale ? `<span class="history-asof">as of ${formatEasternTime(asOf)}</span>` : ""}`;
  }

  function renderHistorySection() {
    const section = $("#history-section");
    if (!section) return;
    const holdings = Data.all().filter(isHistoryHolding);
    if (!holdings.length) {
      section.style.display = "none";
      return;
    }
    section.style.display = "block";
    const spec = historyRangeSpec();
    renderHistoryRangeChips(spec);

    // Assemble the coherent snapshot from cache: fixed USD is a flat $1 line,
    // fetched series must be fresh for this range's TTL.
    const seriesByTicker = new Map();
    let asOf = Infinity;
    historyTickers().forEach(sym => {
      const entry = freshHistoryEntry(sym, spec);
      if (!entry) return;
      seriesByTicker.set(sym, entry.points);
      asOf = Math.min(asOf, entry.fetchedAt);
    });
    if (!Number.isFinite(asOf)) asOf = Date.now();
    holdings.forEach(inv => {
      const sym = String(inv.Ticker || "").trim().toUpperCase();
      if (fixedPriceForTicker(sym) != null && !seriesByTicker.has(sym)) {
        seriesByTicker.set(sym, [[asOf - spec.ms, 1], [asOf, 1]]);
      }
    });

    const series = Data.historyValueSeries(seriesByTicker, {
      start: asOf - spec.ms,
      end: asOf,
      points: HISTORY_GRID_POINTS,
      taxOn: ui.taxOn,
      filter: isHistoryHolding
    });

    const chart = $("#history-chart");
    if (!series.included.length) {
      if (chart) chart.innerHTML = "";
      const readout = $("#history-readout");
      if (readout) readout.innerHTML = "";
      setHistoryStatus(historyFetchKey ? "Loading price history…" : "No price history available yet for this range.");
      ensureHistorySeries();
      return;
    }

    renderHistoryReadout(series, spec, asOf);
    drawHistoryChart(chart, series, spec);

    const notes = [];
    const excludedSyms = [...new Set(series.excluded.map(inv => String(inv.Ticker || "").trim().toUpperCase()))];
    if (excludedSyms.length) {
      const reasons = excludedSyms.map(sym => {
        const failure = historyFailures.get(historyCacheKey(sym, spec.key));
        return failure ? `${sym} (${failure.message})` : sym;
      });
      notes.push(`No ${spec.label} history for: ${reasons.join(", ")}`);
    }
    const start = asOf - spec.ms;
    const shallow = [...seriesByTicker.entries()]
      .filter(([sym, pts]) => seriesTickerUsed(series, sym) && pts[0][0] > start + spec.ms * .05)
      .map(([sym]) => sym);
    if (shallow.length) notes.push(`Held flat before first data: ${shallow.join(", ")}`);
    if (historyFetchKey) notes.push("Loading more price history…");
    setHistoryStatus(notes.join(" · "));

    ensureHistorySeries();
  }

  function seriesTickerUsed(series, sym) {
    return series.included.some(inv => String(inv.Ticker || "").trim().toUpperCase() === sym);
  }

  function renderLeverage() {
    const wrap = $("#debt-leverage");
    if (!wrap) return;
    const leverage = Data.leverage(ui.taxOn);
    const fill = Number.isFinite(leverage.margin) ? clamp(leverage.margin, 0, 1) : 1;
    const levelClass = `level-${slug(leverage.level)}`;
    const markers = Data.LEVERAGE_LEVELS
      .filter(level => Number.isFinite(level.maxMargin) && level.maxMargin > 0)
      .map(level => `<span class="leverage-marker" style="left:${(level.maxMargin * 100).toFixed(1)}%" title="${level.level} up to ${fmtLeveragePct(level.maxMargin)} margin"></span>`)
      .join("");
    const thresholdKey = Data.LEVERAGE_LEVELS
      .filter(level => Number.isFinite(level.maxMargin) && level.maxMargin > 0)
      .map(level => fmtLeveragePct(level.maxMargin))
      .join(" / ");

    wrap.innerHTML = `
      <div class="leverage-headline">
        <div>
          <div class="leverage-k">Assets / net worth</div>
          <div class="leverage-ratio">${fmtMultiple(leverage.ratio)}</div>
        </div>
        <span class="leverage-level ${levelClass}">${leverage.level}</span>
      </div>
      <div class="leverage-gauge" role="img" aria-label="Margin ${fmtLeveragePct(leverage.margin)}, level ${leverage.level}">
        <div class="leverage-fill ${levelClass}" style="width:${(fill * 100).toFixed(1)}%"></div>
        ${markers}
      </div>
      <div class="leverage-metrics">
        <div><span>Margin</span><b>${fmtLeveragePct(leverage.margin)}</b></div>
        <div><span>Debt</span><b>${fmt$full(leverage.debt)}</b></div>
        <div><span>Assets</span><b>${fmt$full(leverage.assets)}</b></div>
      </div>
      <div class="leverage-note">margin = debt / assets · thresholds ${thresholdKey}${ui.taxOn ? " · post-tax" : ""}</div>`;
  }

  function renderDebts() {
    const section = $("#debt-section");
    const anyDebt = Data.all().some(Data.isDebt);
    section.style.display = anyDebt ? "block" : "none";
    if (!anyDebt) return;
    const owed = Data.debtTotal(ui.taxOn);
    hBars($("#debt-bars"), Data.groupBy("Ticker", ui.taxOn, Data.isDebt), {
      denominator: owed,
      denominatorLabel: "total debt owed"
    });
    hBars($("#debt-inst-bars"), Data.groupBy("Institution", ui.taxOn, Data.isDebt), {
      denominator: owed,
      denominatorLabel: "total debt owed"
    });
    renderLeverage();
  }

  /* ---------- master render ---------- */

  function renderAll() {
    syncPrivacyControlToDom();
    if (moneyHidden()) {
      ui.editingId = null;
      activeInlineEditor = null;
    }
    const hasData = Data.all().length > 0;
    $("#dashboard").style.display = hasData ? "block" : "none";
    $("#hero-empty").style.display = hasData ? "none" : "block";
    renderCopyBar();
    renderTable();
    renderHeroAmount();
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
      monthlyContribution: effectiveSimpleMonthly(),
      taxOn: ui.taxOn
    });
    syncProjectionModeToDom();
    syncBiomeModeToDom();
    $("#monthly-out").textContent = fmt$full(ui.monthly) + "/mo";
    $("#simple-rate-out").textContent = fmtPct(ui.simpleRate) + "/yr";
    const simpleMonthlyInput = $("#simple-monthly-input");
    if (simpleMonthlyInput) {
      ui.simpleMonthly = rangeValue(ui.simpleMonthly, RANGE_LIMITS.simpleMonthly);
      simpleMonthlyInput.value = moneyHidden() ? "" : String(ui.simpleMonthly);
      simpleMonthlyInput.placeholder = moneyHidden() ? MONEY_MASK : "$/mo";
      simpleMonthlyInput.disabled = moneyHidden();
      simpleMonthlyInput.title = moneyHidden()
        ? "Turn off privacy mode to edit this simple monthly contribution"
        : "Saved monthly amount for the Simple projection; use the toggle to apply it";
    }
    const simpleMonthlyOut = $("#simple-monthly-out");
    if (simpleMonthlyOut) simpleMonthlyOut.textContent = simpleMonthlyOutputText();
    const simpleMonthlyEnabled = $("#simple-monthly-enabled");
    if (simpleMonthlyEnabled) {
      simpleMonthlyEnabled.checked = ui.simpleMonthlyEnabled;
      const label = $("#simple-monthly-enabled-label");
      if (label) label.textContent = ui.simpleMonthlyEnabled ? "On" : "Off";
      const block = simpleMonthlyEnabled.closest(".simple-monthly-block");
      if (block) block.classList.toggle("is-disabled", !ui.simpleMonthlyEnabled);
    }
    const controlsSummary = $("#proj-controls-summary");
    if (controlsSummary) {
      controlsSummary.textContent = ui.projectionView === "simple"
        ? `${ui.years}Y · ${fmtPct(ui.simpleRate)}/yr · ${ui.simpleMonthlyEnabled ? fmt$(ui.simpleMonthly) + "/mo simple" : fmt$(0) + "/mo simple off" + (ui.simpleMonthly > 0 ? ` (${fmt$(ui.simpleMonthly)} saved)` : "")}${ui.taxOn ? " · post-tax" : ""}`
        : `${ui.years}Y · ${ui.contribTouched ? fmt$(proj.contrib.total) + "/mo exact" : fmt$(ui.monthly) + "/mo"} · ${proj.contrib.count} target${proj.contrib.count === 1 ? "" : "s"}${ui.taxOn ? " · post-tax" : ""}`;
    }
    renderContribChips(proj.contrib);
    renderAmortizedDebtCosts();
    renderStats(proj, aggregateProj);
    renderProjectionReadout(proj);
    renderHeroExperience();
    renderBiome();
    if (ui.projectionView === "simple") {
      aggregateLineChart($("#proj-chart"), aggregateProj);
      renderAggregateProjectionReadout(aggregateProj);
    } else {
      stackedArea($("#proj-chart"), proj);
    }
    renderBalanceSheet();
    renderHistorySection();

    // Composition is scoped to INVESTED ASSETS so donut/bar totals equal what's
    // invested (not net worth). Debts get their own section below.
    const invested = Data.assetTotal(ui.taxOn);
    $("#donut-scope-note").textContent = `${fmt$full(invested)} invested${ui.taxOn ? " · post-tax" : ""}`;

    const grid = $("#donut-grid");
    grid.innerHTML = "";
    ASSET_DIMS.forEach(dim =>
      donut(grid, "% by " + dimLabel(dim), Data.groupBy(dim, ui.taxOn, Data.isAsset), "invested"));
    assetDebtChart(grid, invested, Data.debtTotal(ui.taxOn));

    hBars($("#ticker-bars"), Data.groupBy("Ticker", ui.taxOn, Data.isAsset), {
      denominator: invested,
      denominatorLabel: "total invested assets"
    });
    institutionAccountBars($("#xtab-institution-account"), Data.crossTab("Institution", "Account Type", ui.taxOn, Data.isAsset), invested);

    renderDebts();
  }

  /* ---------- settings view ---------- */

  let settingsLastFocus = null;

  function settingsFocusables(view) {
    return [...view.querySelectorAll([
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled]):not([type='hidden'])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])"
    ].join(","))].filter(node => {
      const style = window.getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden";
    });
  }

  function setSettingsOpen(open, { restoreFocus = true } = {}) {
    const view = $("#settings-view");
    const toggle = $("#ops-menu-toggle");
    const backdrop = $("#settings-backdrop");
    if (!view || !toggle) return;
    if (open) {
      settingsLastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : toggle;
      if (backdrop) {
        backdrop.hidden = true;
        backdrop.classList.remove("is-open");
      }
      document.body.classList.add("settings-open");
      view.classList.add("is-open");
      view.setAttribute("aria-hidden", "false");
      view.inert = false;
      view.removeAttribute("inert");
      toggle.setAttribute("aria-expanded", "true");
      toggle.setAttribute("aria-label", "Close portfolio settings");
      toggle.setAttribute("title", "Close portfolio settings");
      requestAnimationFrame(() => {
        toggle.focus();
      });
      return;
    }
    document.body.classList.remove("settings-open");
    view.classList.remove("is-open");
    if (backdrop) {
      backdrop.classList.remove("is-open");
      backdrop.hidden = true;
    }
    view.setAttribute("aria-hidden", "true");
    view.inert = true;
    view.setAttribute("inert", "");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Open portfolio settings");
    toggle.setAttribute("title", "Open portfolio settings");
    if (restoreFocus && settingsLastFocus && typeof settingsLastFocus.focus === "function") {
      settingsLastFocus.focus();
    }
  }

  function wireSettingsView() {
    const view = $("#settings-view");
    const toggle = $("#ops-menu-toggle");
    const backdrop = $("#settings-backdrop");
    const emptyOpen = $("#empty-open-controls");
    if (!view || !toggle) return;
    toggle.addEventListener("click", () => setSettingsOpen(toggle.getAttribute("aria-expanded") !== "true"));
    if (backdrop) backdrop.addEventListener("click", () => setSettingsOpen(false));
    if (emptyOpen) emptyOpen.addEventListener("click", () => setSettingsOpen(true, { restoreFocus: false }));
    document.addEventListener("keydown", e => {
      if (!view.classList.contains("is-open")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        setSettingsOpen(false);
      }
    });
  }

  function wireHeaderOverlay() {
    const actions = $(".header-actions");
    if (!actions) return;

    const FLOAT_AFTER = 96;
    const DIRECTION_DELTA = 4;
    let lastY = null;
    let pending = false;

    const scrollY = () => Math.max(0, window.scrollY || window.pageYOffset || 0);
    const setVisible = visible => {
      document.body.classList.toggle("header-actions-visible", visible);
    };
    const setFloating = floating => {
      document.body.classList.toggle("header-actions-overlay", floating);
      if (!floating) setVisible(false);
    };

    const sync = () => {
      pending = false;
      const y = scrollY();
      const previous = lastY;
      const delta = previous == null ? 0 : y - previous;
      const hasFocus = actions.contains(document.activeElement);
      const isPastFloatPoint = y > FLOAT_AFTER;
      const isFloating = document.body.classList.contains("header-actions-overlay");
      const isScrollingUp = delta < -DIRECTION_DELTA;
      const isScrollingDown = delta > DIRECTION_DELTA;

      if (!isPastFloatPoint) {
        setFloating(false);
      } else if (hasFocus || isScrollingUp) {
        setFloating(true);
        setVisible(true);
      } else if (isScrollingDown) {
        if (isFloating) setVisible(false);
        else setFloating(false);
      }

      lastY = y;
    };

    const schedule = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(sync);
    };

    actions.addEventListener("focusin", () => {
      if (scrollY() > FLOAT_AFTER) {
        setFloating(true);
        setVisible(true);
      }
    });
    actions.addEventListener("pointerenter", () => {
      if (scrollY() > FLOAT_AFTER && document.body.classList.contains("header-actions-overlay")) {
        setVisible(true);
      }
    });
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    sync();
  }

  /* ---------- controls wiring ---------- */

  function syncLedgerGroupingControl() {
    const select = $("#ledger-group-by");
    if (!select) return;
    ui.ledgerGroupBy = coerceLedgerGroupBy(ui.ledgerGroupBy);
    select.innerHTML = "";
    [...LEDGER_GROUP_DIMS, LEDGER_UNGROUPED].forEach(dim => {
      const option = el("option");
      option.value = dim;
      option.textContent = dim === LEDGER_UNGROUPED ? "Ungrouped" : dimLabel(dim);
      if (dim === ui.ledgerGroupBy) option.selected = true;
      select.appendChild(option);
    });
  }

  function wireControls() {
    const years = $("#years-slider"), monthly = $("#monthly-slider"), simpleRate = $("#simple-rate-slider");
    const simpleMonthly = $("#simple-monthly-input"), simpleMonthlyEnabled = $("#simple-monthly-enabled");
    const privacyToggle = $("#privacy-toggle");
    const themeModeToggle = $("#theme-mode-toggle");
    const projectionControlsPanel = $(".proj-controls-panel");
    syncProjectionControlsToDom();
    syncLedgerGroupingControl();
    if (projectionControlsPanel) {
      projectionControlsPanel.addEventListener("toggle", () => {
        ui.projectionControlsOpen = projectionControlsPanel.open;
        saveUiState();
      });
    }
    if (privacyToggle) {
      privacyToggle.addEventListener("click", () => {
        ui.privacyMode = !ui.privacyMode;
        if (ui.privacyMode) ui.editingId = null;
        saveUiState();
        renderAll();
        toast(ui.privacyMode ? "Monetary amounts hidden" : "Monetary amounts visible");
      });
    }
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
    // Night-mode toggle: dark maps to the native theme; non-dark maps to white.
    if (themeModeToggle) {
      themeModeToggle.addEventListener("click", () => {
        ui.theme = ui.theme === "dark" ? LIGHT_TOGGLE_THEME : "dark";
        syncThemeToDom();
        saveUiState();
      });
    }
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
    simpleMonthly.addEventListener("input", () => {
      const wasZero = ui.simpleMonthly <= 0;
      ui.simpleMonthly = rangeValue(simpleMonthly.value, RANGE_LIMITS.simpleMonthly);
      if (ui.simpleMonthly <= 0) ui.simpleMonthlyEnabled = false;
      else if (wasZero) ui.simpleMonthlyEnabled = true;
      simpleMonthly.value = String(ui.simpleMonthly);
      $("#simple-monthly-out").textContent = simpleMonthlyOutputText();
      if (simpleMonthlyEnabled) simpleMonthlyEnabled.checked = ui.simpleMonthlyEnabled;
      saveUiState();
      renderAll();
    });
    simpleMonthlyEnabled.addEventListener("change", () => {
      ui.simpleMonthlyEnabled = simpleMonthlyEnabled.checked;
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
    $("#ledger-group-by").addEventListener("change", e => {
      ui.ledgerGroupBy = coerceLedgerGroupBy(e.target.value);
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

    const addPanel = $("#add-form-panel");
    if (addPanel) addPanel.hidden = false;

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
      if (moneyHidden()) { toast("Turn off privacy mode to fetch a visible price"); return; }
      const label = fetchBtn.textContent;
      fetchBtn.disabled = true; fetchBtn.textContent = "…";
      try {
        const q = await Prices.quote(sym);
        $("#f-price").value = q.price;
        refreshFormAmortPayment();
        toast(`${q.ticker} · ${fmt$cents(q.price)} · ${q.source}`);
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

  function exportBaseName() {
    return `coldledger-${slug(Portfolios.activeName() || "ledger") || "ledger"}`;
  }

  function downloadTextFile(text, filename, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function readImportFile(accept) {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.style.position = "fixed";
      input.style.left = "-9999px";
      input.addEventListener("change", () => {
        const file = input.files && input.files[0];
        input.remove();
        if (!file) {
          resolve(null);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(new Error("could not read selected file"));
        reader.readAsText(file);
      }, { once: true });
      document.body.appendChild(input);
      input.click();
    });
  }

  function importLedgerRows(name, investments) {
    Portfolios.importCopy(name, investments);
    resetContributionState();
    resetFloatPositionState();
    saveUiState();
    renderAll();
    toast(`Imported ${Data.all().length} positions into "${Portfolios.activeName()}"`);
  }

  async function exportLedger(format) {
    if (format === "clipboard") {
      const backup = Data.toJSON();
      await writeClipboardText(backup);
      toast("Backup copied to clipboard");
      return;
    }

    const base = exportBaseName();
    if (format === "csv") {
      downloadTextFile(Data.toCSV(), `${base}.csv`, "text/csv;charset=utf-8");
      toast("CSV exported");
      return;
    }
    if (format === "md") {
      downloadTextFile(Data.toMarkdown(), `${base}.md`, "text/markdown;charset=utf-8");
      toast("Markdown exported");
    }
  }

  async function importLedger(format) {
    if (!canCreateLedger()) {
      toast(ledgerLimitMessage());
      return;
    }

    if (format === "clipboard") {
      const investments = parseClipboardBackup(await readClipboardText());
      importLedgerRows("Imported from clipboard", investments);
      return;
    }

    const specs = {
      csv: {
        accept: ".csv,text/csv",
        parse: Data.parseCSV,
        name: "Imported from CSV",
        empty: "selected CSV is empty"
      },
      md: {
        accept: ".md,.markdown,text/markdown,text/plain",
        parse: Data.parseMarkdown,
        name: "Imported from Markdown",
        empty: "selected Markdown file is empty"
      }
    };
    const spec = specs[format];
    if (!spec) return;

    const text = await readImportFile(spec.accept);
    if (text == null) return;
    if (!text.trim()) throw new Error(spec.empty);
    importLedgerRows(spec.name, spec.parse(text));
  }

  // Re-price every auto-priced holding: fixed-price tickers like USD plus
  // positions that look like securities (see looksTradable). Call-signs like
  // HOUSE/DEBT and cash/loans keep their manual value.
  async function refreshLivePrices({ manual = true } = {}) {
    const refreshBtn = $("#refresh-prices");
    const invs = Data.all();
    const notify = manual;
    if (invs.length === 0) {
      updateLivePriceStatus("No positions");
      if (notify) toast("Nothing to price yet");
      return { ok: false, priced: 0, total: 0 };
    }
    const tradable = invs.filter(shouldAutoPrice);
    if (tradable.length === 0) {
      updateLivePriceStatus("Manual values");
      if (notify) toast("No auto-priced tickers — values are manual");
      return { ok: false, priced: 0, total: 0 };
    }
    const label = refreshBtn ? refreshBtn.getAttribute("aria-label") || "Refresh live prices" : "";
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.classList.add("is-busy");
      refreshBtn.setAttribute("aria-label", "Refreshing live prices");
      refreshBtn.title = "Refreshing live prices";
    }
    updateLivePriceStatus("Refreshing prices");
    try {
      const quotes = await Prices.quoteMany(tradable.map(i => i.Ticker));
      let priced = 0;
      tradable.forEach(inv => {
        const q = quotes.get((inv.Ticker || "").toUpperCase());
        if (q) { Data.update(inv.ID, { "Value": inv.Amount * q.price }); priced++; }
      });
      const missed = tradable.length - priced;
      if (priced) {
        markLivePriceRefreshSuccess();
        if (notify) toast(`Priced ${priced}/${tradable.length}${missed ? ` · ${missed} unresolved` : ""}`);
        return { ok: true, priced, total: tradable.length };
      }

      updateLivePriceStatus("No prices found");
      if (notify) toast("No prices found — enter values manually");
      return { ok: false, priced, total: tradable.length };
    } catch (err) {
      updateLivePriceStatus("Refresh failed");
      if (notify) toast("Price refresh failed: " + err.message);
      else console.warn("Initial price refresh failed:", err);
      return { ok: false, error: err, priced: 0, total: tradable.length };
    } finally {
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.classList.remove("is-busy");
        refreshBtn.setAttribute("aria-label", label);
        refreshBtn.title = "Refresh live prices";
      }
    }
  }

  function refreshPricesAfterLoad() {
    updateLivePriceStatus();
    // Throttle only the page-load refresh so reloads do not hammer public quote
    // APIs; the manual Refresh prices button intentionally bypasses this.
    if (shouldSkipPageLoadPriceRefresh()) return;
    window.setTimeout(() => { refreshLivePrices({ manual: false }); }, 0);
  }

  function wireIO() {
    const menus = [
      { toggle: $("#import-menu-toggle"), menu: $("#import-menu") },
      { toggle: $("#copy-json"), menu: $("#export-menu") }
    ].filter(pair => pair.toggle && pair.menu);

    const closeMenus = focusToggle => {
      menus.forEach(({ toggle, menu }) => {
        const wasOpen = toggle.getAttribute("aria-expanded") === "true";
        menu.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
        if (focusToggle && wasOpen) toggle.focus();
      });
    };
    const openMenu = pair => {
      closeMenus(false);
      pair.menu.hidden = false;
      pair.toggle.setAttribute("aria-expanded", "true");
      const first = pair.menu.querySelector("button");
      if (first) first.focus();
    };

    menus.forEach(pair => {
      pair.toggle.addEventListener("click", e => {
        e.stopPropagation();
        if (pair.toggle.getAttribute("aria-expanded") === "true") closeMenus(false);
        else openMenu(pair);
      });
      pair.toggle.addEventListener("keydown", e => {
        if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openMenu(pair);
        }
      });
      pair.menu.addEventListener("keydown", e => {
        const items = [...pair.menu.querySelectorAll("button")];
        const idx = items.indexOf(document.activeElement);
        if (e.key === "Escape") {
          e.preventDefault();
          closeMenus(true);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          items[(idx + 1) % items.length].focus();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          items[(idx - 1 + items.length) % items.length].focus();
        }
      });
    });
    document.addEventListener("click", e => {
      if (!e.target.closest(".io-menu-wrap")) closeMenus(false);
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") closeMenus(false);
    });

    document.querySelectorAll("[data-export-format]").forEach(btn => btn.addEventListener("click", async e => {
      const format = e.currentTarget.dataset.exportFormat;
      closeMenus(false);
      try {
        await exportLedger(format);
      } catch (err) {
        toast(format === "clipboard" ? "Couldn't copy backup: " + err.message : "Export failed: " + err.message);
      }
    }));

    document.querySelectorAll("[data-import-format]").forEach(btn => btn.addEventListener("click", async e => {
      const format = e.currentTarget.dataset.importFormat;
      const toggle = $("#import-menu-toggle");
      const label = toggle.getAttribute("aria-label") || "Import ledger data";
      const title = toggle.title;
      closeMenus(false);
      toggle.disabled = true;
      toggle.classList.add("is-busy");
      toggle.setAttribute("aria-label", "Importing ledger data");
      toggle.title = "Importing ledger data";
      try {
        await importLedger(format);
      } catch (err) {
        const prefix = format === "clipboard" ? "Clipboard import failed: " : format === "csv" ? "CSV import failed: " : "Markdown import failed: ";
        toast(prefix + err.message);
      } finally {
        toggle.disabled = false;
        toggle.classList.remove("is-busy");
        toggle.setAttribute("aria-label", label);
        toggle.title = title;
      }
    }));

    const refreshBtn = $("#refresh-prices");
    refreshBtn.addEventListener("click", () => refreshLivePrices());

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
      resetFloatPositionState();
      saveUiState();
      renderAll();
      toast("Sample portfolio loaded");
    });
  }

  /* ---------- boot ---------- */

  loadStoredProjectionState();
  wireSettingsView();
  wireHeaderOverlay();
  wireControls();
  wireForm();
  wireIO();
  renderHeroAmount();

  // Portfolios.init() restores the active copy from localStorage (seeding a
  // "Default" from tickers.json only on first run), then we subscribe the
  // renderer so it draws once against restored state.
  Portfolios.init().then(() => {
    loadActivePortfolioUiState();
    syncProjectionControlsToDom();
    Data.subscribe(renderAll);
    renderAll();
    refreshPricesAfterLoad();
  });

})();
