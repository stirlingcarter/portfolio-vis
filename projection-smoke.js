const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const dataSource = fs.readFileSync(path.join(__dirname, "data.js"), "utf8");
const sandbox = {};
vm.runInNewContext(`${dataSource}\nglobalThis.Data = Data;`, sandbox, { filename: "data.js" });
const { Data } = sandbox;

function approx(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: expected ${expected}, got ${actual}`);
}

function row(fields) {
  return {
    "ID": fields.ID,
    "Ticker": fields.Ticker,
    "Institution": "Test",
    "Account Type": fields["Account Type"] || "Ledger",
    "Amount": 1,
    "Value": fields.Value,
    "Kind": fields.Kind || "Asset",
    "Category": fields.Category || "",
    "Subcategory": "",
    "Nominal Rate": fields["Nominal Rate"] ?? 0,
    "Nominal tax rate": "",
    "Amort Months": fields["Amort Months"] ?? "",
    "Amort Payment": fields["Amort Payment"] ?? ""
  };
}

approx(Data.inferAmortPayment(100000, 0.06, 360), 599.55, "infers standard amortizing mortgage payment");
approx(Data.inferAmortPayment(12000, 0, 12), 1000, "zero-rate amortization divides principal by months");
assert.equal(Data.inferAmortPayment(12000, 0.06, 0), "", "invalid term does not infer a payment");

Data.loadArray([
  row({ ID: 1, Ticker: "ASSET", Value: 1000, "Amort Months": 12, "Amort Payment": 100 })
]);
assert.equal(Data.all()[0]["Amort Months"], "", "asset rows do not persist amortization months");
assert.equal(Data.all()[0]["Amort Payment"], "", "asset rows do not persist amortization payments");

Data.loadArray([
  row({ ID: 1, Ticker: "ASSET", Value: 1000 }),
  row({ ID: 2, Ticker: "LOAN", Value: 12000, Kind: "Debt", "Amort Months": 12, "Amort Payment": 1000 })
]);

const detailed = Data.projection({
  years: 1,
  monthlyTotal: 100,
  contribIds: new Set([1, 2]),
  contribAmounts: null,
  taxOn: false
});
const asset = detailed.series.find(s => s.id === 1);
const debt = detailed.series.find(s => s.id === 2);

assert.equal(detailed.contrib.count, 1, "amortized debt is not contribution-eligible");
assert.equal(detailed.contrib.total, 100, "monthly budget stays assigned to eligible assets");
assert.equal(asset.contribution, 100, "asset receives the full monthly budget");
assert.equal(debt.contribution, 0, "amortized debt receives no contribution budget");
approx(asset.values[12], 2200, "asset grows by independent contribution budget");
approx(debt.values[0], -12000, "detailed debt starts signed negative");
approx(debt.values[6], -6000, "detailed debt pays down steadily");
approx(debt.values[12], 0, "detailed debt reaches zero by term");
for (let m = 1; m < debt.values.length; m++) {
  assert.ok(debt.values[m] >= debt.values[m - 1], "detailed amortized debt never grows more negative");
}

Data.loadArray([
  row({ ID: 1, Ticker: "ASSET", Value: 1000 }),
  row({ ID: 2, Ticker: "CAR", Value: 12000, Kind: "Debt", "Amort Months": 12, "Amort Payment": 1000 }),
  row({ ID: 3, Ticker: "NOTE", Value: 6000, Kind: "Debt", "Amort Months": 6, "Amort Payment": 1000 }),
  row({ ID: 4, Ticker: "MARGIN", Value: 3000, Kind: "Debt" })
]);

const simple = Data.aggregateProjection({ years: 1, rate: 0, taxOn: false });
approx(simple.assets[12], 1000, "simple assets use aggregate rate");
approx(simple.debts[0], 21000, "simple debt starts as positive total balance");
approx(simple.debts[6], 9000, "simple debt sums per-debt amortization schedules");
approx(simple.debts[12], 3000, "simple amortized debts are zero by their terms");
assert.equal(simple.debt.amortized, 2, "simple projection reports amortized debt count");
assert.equal(simple.debt.carried, 1, "simple projection reports carried debt count");

console.log("ok - projection amortization smoke");
