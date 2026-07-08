/* ============================================================
   PERSISTENCE LAYER — named portfolio "copies" in localStorage.
   Sits between Data (the in-memory current portfolio) and the UI.

   Model: many copies, one active. The active copy's positions ARE Data's
   positions — we load a copy into Data on switch, and mirror Data back into
   the active copy on every change (via Data.subscribe). localStorage is the
   source of truth across reloads; tickers.json is only a first-run seed / an
   import option. No network, nothing leaves the browser.
   ============================================================ */

const Portfolios = (() => {

  const KEY = "coldledger.portfolios.v1";
  const MAX_LEDGER_COPIES = 8;

  // state = { activeId, order:[id...], copies:{ id: {id,name,updatedAt,investments[]} } }
  let state = null;
  let persistBound = false;

  const uid = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const now = () => Date.now();

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
  }
  function write() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* quota / privacy mode */ }
  }

  function activeCopy() { return state && state.copies[state.activeId]; }

  function loadActiveIntoData() {
    const c = activeCopy();
    Data.loadArray(c ? c.investments : []);   // fires notify → persistFromData writes the normalized set back
  }

  // Mirror Data → active copy on every change. Data.loadArray normalizes IDs,
  // so this also cleans up any hand-edited duplicate/missing IDs permanently.
  function persistFromData() {
    const c = activeCopy();
    if (!c) return;
    c.investments = Data.all();
    c.updatedAt = now();
    write();
  }

  function bindPersist() {
    if (persistBound) return;
    Data.subscribe(persistFromData);
    persistBound = true;
  }

  function makeCopy(name, investments) {
    if (state.order.length >= MAX_LEDGER_COPIES) return null;
    const id = uid();
    state.copies[id] = { id, name, updatedAt: now(), investments: investments || [] };
    state.order.push(id);
    return id;
  }

  function uniqueName(base) {
    const clean = (base || "Untitled").trim() || "Untitled";
    const existing = new Set(Object.values(state.copies).map(c => c.name));
    if (!existing.has(clean)) return clean;
    let n = 2;
    while (existing.has(`${clean} ${n}`)) n++;
    return `${clean} ${n}`;
  }

  // First-run seed: import an adjacent tickers.json if the browser will serve it
  // (works over http://, blocked under file:// — then we just start empty).
  async function seedInvestments() {
    try {
      const res = await fetch("tickers.json", { cache: "no-store" });
      if (res.ok) {
        const arr = JSON.parse(await res.text());
        if (Array.isArray(arr)) return arr;
      }
    } catch { /* fall through to empty */ }
    return [];
  }

  async function init() {
    state = read();
    if (!state || !state.copies || !Array.isArray(state.order) || state.order.length === 0) {
      state = { activeId: null, order: [], copies: {} };
      const seed = await seedInvestments();
      state.activeId = makeCopy("Default", seed);
      write();
    }
    if (!state.copies[state.activeId]) state.activeId = state.order[0];
    bindPersist();
    loadActiveIntoData();
  }

  /* ---------- copy management ---------- */

  function list() {
    return state.order.map(id => {
      const c = state.copies[id];
      return { id, name: c.name, count: c.investments.length, active: id === state.activeId, updatedAt: c.updatedAt };
    });
  }
  function activeId() { return state.activeId; }
  function activeName() { const c = activeCopy(); return c ? c.name : ""; }

  function switchTo(id) {
    if (!state.copies[id] || id === state.activeId) return;
    state.activeId = id;        // current copy is already mirrored via the subscription
    write();
    loadActiveIntoData();
  }

  function create(name) {
    const id = makeCopy((name || "Untitled").trim() || "Untitled", []);
    if (!id) return;
    state.activeId = id;
    write();
    loadActiveIntoData();
    return state.activeId;
  }

  function duplicate(id) {
    const src = state.copies[id || state.activeId];
    if (!src) return;
    const copyId = makeCopy(uniqueName(src.name + " copy"), src.investments.map(x => ({ ...x })));
    if (!copyId) return;
    state.activeId = copyId;
    write();
    loadActiveIntoData();
    return state.activeId;
  }

  function importCopy(name, investments) {
    if (!Array.isArray(investments)) throw new Error("JSON root must be an array of investments.");
    const id = makeCopy(uniqueName(name || "Imported from clipboard"), investments.map(x => ({ ...x })));
    if (!id) throw new Error(`Maximum of ${MAX_LEDGER_COPIES} ledgers reached.`);
    state.activeId = id;
    write();
    loadActiveIntoData();
    return state.activeId;
  }

  function rename(id, name) {
    const c = state.copies[id];
    if (!c || !name || !name.trim()) return;
    c.name = name.trim();
    c.updatedAt = now();
    write();
  }

  function remove(id) {
    if (!state.copies[id]) return;
    delete state.copies[id];
    state.order = state.order.filter(x => x !== id);
    if (state.order.length === 0) state.activeId = makeCopy("Default", []);
    else if (state.activeId === id) state.activeId = state.order[0];
    write();
    loadActiveIntoData();
  }

  function maxLedgers() { return MAX_LEDGER_COPIES; }

  return { init, list, activeId, activeName, switchTo, create, duplicate, importCopy, rename, remove, maxLedgers };
})();
