const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const dataSource = fs.readFileSync(path.join(__dirname, "data.js"), "utf8");
const uiSource = fs.readFileSync(path.join(__dirname, "ui.js"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
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

console.log("ok - ledger summaries show assets, debts, net and defaults");
