const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const dataSource = fs.readFileSync(path.join(__dirname, "data.js"), "utf8");
const uiSource = fs.readFileSync(path.join(__dirname, "ui.js"), "utf8");
const portfoliosSource = fs.readFileSync(path.join(__dirname, "portfolios.js"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const stylesSource = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8");
const sandbox = {};
vm.runInNewContext(`${dataSource}\nglobalThis.Data = Data;`, sandbox, { filename: "data.js" });
const { Data } = sandbox;

function row(fields) {
  return {
    "ID": fields.ID,
    "Ticker": fields.Ticker,
    "Institution": fields.Institution ?? "Test Bank",
    "Account Type": fields["Account Type"] ?? "Brokerage",
    "Amount": 1,
    "Value": fields.Value,
    "Kind": fields.Kind || "Asset",
    "Category": fields.Category || "",
    "Subcategory": fields.Subcategory || "",
    "Nominal Rate": 0,
    "Nominal tax rate": "",
    "Amort Months": "",
    "Amort Payment": ""
  };
}

function groupedLedgerTotals(dimension) {
  const groups = new Map();
  Data.all().forEach(inv => {
    const label = String(inv[dimension] ?? "").trim() || "Unlabeled";
    const totals = groups.get(label) || { assets: 0, debts: 0 };
    const value = Math.abs(Number(Data.presentValue(inv, false)) || 0);
    if (Data.isDebt(inv)) totals.debts += value;
    else totals.assets += value;
    groups.set(label, totals);
  });
  return groups;
}

Data.loadArray([
  row({ ID: 1, Ticker: "ASSET", Institution: "Test Bank", Value: 100 }),
  row({ ID: 2, Ticker: "LOAN", Institution: "Test Bank", Value: 40, Kind: "Debt" }),
  row({ ID: 3, Ticker: "CASH", Institution: "Credit Union", "Account Type": "", Value: 20 }),
  row({ ID: 4, Ticker: "CARD", Institution: "Credit Union", Value: 10, Kind: "Debt" })
]);

const byInstitution = groupedLedgerTotals("Institution");
const testBank = byInstitution.get("Test Bank");
assert.deepEqual(testBank, { assets: 100, debts: 40 }, "institution group tracks asset and debt magnitudes");
assert.equal(testBank.assets - testBank.debts, 60, "institution group net is assets minus debts");
assert.deepEqual(groupedLedgerTotals("Kind").get("Asset"), { assets: 120, debts: 0 }, "asset kind group has zero debts");
assert.deepEqual(groupedLedgerTotals("Kind").get("Debt"), { assets: 0, debts: 50 }, "debt kind group uses positive debt magnitude");
assert.deepEqual(groupedLedgerTotals("Account Type").get("Unlabeled"), { assets: 20, debts: 0 }, "blank grouping labels are clean");

assert.match(uiSource, /ledgerGroupBy:\s*"Institution"/, "institution is the no-history ledger grouping default");
assert.match(uiSource, /const LEDGER_GROUP_DIMS = Data\.TAG_DIMENSIONS\.slice\(\);/, "ledger grouping follows tag dimensions");
assert.match(uiSource, /Assets \$\{fmt\$full\(assets\)\} · Debts \$\{fmt\$full\(debts\)\} · Net \$\{fmt\$full\(net\)\}/, "ledger summaries show assets, debts, and net");
assert.match(uiSource, /ledgerGroupBlock\("All positions", rows\)/, "ungrouped ledger keeps the same summary shape");
assert.doesNotMatch(uiSource, /ledger-sort-dir|ledgerSortDir/, "ledger sort direction button and state are removed");
assert.ok(
  indexSource.indexOf('<option value="Institution">Institution</option>') <
    indexSource.indexOf('<option value="Account Type">Account type</option>'),
  "institution is first in the grouping control"
);
assert.match(indexSource, /<option value="__ungrouped__">Ungrouped<\/option>/, "ungrouped table remains available");
assert.doesNotMatch(indexSource, /ledger-sort-dir|A-Z/, "A-Z sort direction control is not rendered");
assert.match(indexSource, /id="ledger-tabs" class="ledger-tabs" role="tablist"/, "ledger tabs render as an accessible tablist");
assert.match(indexSource, /id="ledger-tab-panel" class="ledger-tab-panel" role="tabpanel"/, "ledger contents render as a tab panel");
assert.doesNotMatch(indexSource, /id="copy-select"|id="copy-new"|<span>Add ledger<\/span>/, "old bottom portfolio switcher and add ledger button are removed");
assert.doesNotMatch(indexSource, /id="copy-rename"|id="save-dot"/, "rename button and saved indicator are not rendered");
assert.doesNotMatch(indexSource, /ledger-tab-actions|id="copy-dup"|id="copy-del"/, "duplicate and delete controls are not separate from the tabs");
assert.match(uiSource, /const actions = el\("span", "ledger-tab-actions"\)/, "active tab hosts ledger actions");
assert.match(uiSource, /id: "copy-dup"[\s\S]*ledgerDuplicateIcon/, "duplicate action is rendered on the active tab");
assert.match(uiSource, /id: "copy-del"[\s\S]*ledgerDeleteIcon/, "delete action is rendered on the active tab");
const selectedTabRule = stylesSource.match(/\.ledger-tab\[aria-selected="true"\]\s*\{([\s\S]*?)\n\}/);
assert.ok(selectedTabRule, "selected ledger tab style rule exists");
assert.doesNotMatch(
  selectedTabRule[1],
  /\b(?:flex-direction|flex-basis|min-width|max-width|width|min-height|height|padding)\s*:/,
  "selected ledger tabs do not override their base size"
);
assert.match(
  stylesSource,
  /\.ledger-tab-actions\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?transform:\s*translateY\(-50%\);[\s\S]*?\}/,
  "active tab actions are overlaid outside tab sizing"
);
assert.match(
  stylesSource,
  /\.ledger-tab\[aria-selected="true"\]\s+\.ledger-tab-main\s*\{[\s\S]*?padding-right:\s*66px;[\s\S]*?\}/,
  "active tab text reserves room for overlaid actions"
);
assert.doesNotMatch(
  stylesSource,
  /@media \(max-width: 540px\) \{[\s\S]*?\.ledger-tab\[aria-selected="true"\]\s*\{[^}]*\b(?:flex-basis|min-width|width):\s*100%/,
  "mobile selected tabs keep the same wrapped size"
);
assert.match(uiSource, /tab\.setAttribute\("role", "tab"\)/, "portfolio copies render as tabs");
assert.match(uiSource, /id = "ledger-tab-add"/, "persistent plus tab is rendered after portfolio tabs");
assert.match(uiSource, /createLedgerFromPrompt/, "plus tab creates a ledger through the existing creation flow");
assert.match(uiSource, /const MAX_LEDGER_COPIES = Portfolios\.maxLedgers \? Portfolios\.maxLedgers\(\) : 8;/, "ledger UI observes the max-eight cap");
assert.match(uiSource, /ledgerLimitMessage/, "ledger creation shows a max-eight message");
assert.match(uiSource, /function beginLedgerRename\(tab, copy\)/, "active tab title supports inline rename");
assert.match(portfoliosSource, /const MAX_LEDGER_COPIES = 8;/, "portfolio persistence enforces max eight ledgers");
assert.match(uiSource, /Shares \/ Amount/, "ledger labels the debt principal use of Amount");
assert.match(
  uiSource,
  /function amountEditUpdate\(inv, amount\)[\s\S]*if \(inv\.Kind === "Debt"\) \{[\s\S]*update\["Value"\] = amount;[\s\S]*return update;/,
  "inline debt amount edits persist the principal as Value"
);

const PORTFOLIOS_KEY = "coldledger.portfolios.v1";

function makePersistentApp(store) {
  const app = {
    localStorage: {
      getItem: key => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => store.set(key, String(value))
    },
    fetch: async () => ({ ok: false, text: async () => "[]" }),
    Date,
    Math,
    JSON,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    Error,
    console
  };
  vm.runInNewContext(
    `${dataSource}\n${portfoliosSource}\nglobalThis.Data = Data; globalThis.Portfolios = Portfolios;`,
    app,
    { filename: "portfolio-vm.js" }
  );
  return app;
}

async function debtAmountPersistenceSmoke() {
  const store = new Map();
  const app1 = makePersistentApp(store);
  await app1.Portfolios.init();
  app1.Data.loadArray([
    row({ ID: 9, Ticker: "LOAN", Value: 10000, Kind: "Debt", Category: "Loan" })
  ]);

  // Mirrors the inline debt Amount editor: principal edits update both Amount
  // and the valuation field that Data.presentValue prefers after rehydration.
  app1.Data.update(9, { "Amount": 12500, "Value": 12500 });
  const saved = JSON.parse(store.get(PORTFOLIOS_KEY));
  const storedDebt = saved.copies[saved.activeId].investments[0];
  assert.equal(storedDebt.Amount, 12500, "active portfolio stores edited debt Amount");
  assert.equal(storedDebt.Value, 12500, "active portfolio stores edited debt principal Value");

  const app2 = makePersistentApp(store);
  await app2.Portfolios.init();
  const rehydratedDebt = app2.Data.all()[0];
  assert.equal(rehydratedDebt.Amount, 12500, "refresh restores edited debt Amount");
  assert.equal(rehydratedDebt.Value, 12500, "refresh restores edited debt Value");
  assert.equal(app2.Data.debtTotal(false), 12500, "rehydrated debt total uses edited principal");
}

debtAmountPersistenceSmoke()
  .then(() => console.log("ok - ledger summaries, tabs, and debt amount persistence"))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
