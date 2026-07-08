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

const detailedWithdrawal = Data.projection({
  years: 1,
  monthlyTotal: 0,
  contribIds: new Set([1]),
  contribAmounts: new Map([[1, -50]]),
  taxOn: false
});
const withdrawalAsset = detailedWithdrawal.series.find(s => s.id === 1);
assert.equal(detailedWithdrawal.contrib.count, 1, "negative exact contribution remains a selected target");
assert.equal(detailedWithdrawal.contrib.total, -50, "negative exact contribution is included in the monthly total");
assert.equal(withdrawalAsset.contribution, -50, "asset receives the negative exact contribution");
approx(withdrawalAsset.values[12], 400, "negative exact contribution withdraws from the asset monthly");

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
assert.equal(simple.contribution.monthly, 0, "simple contribution defaults to zero");

const simpleWithContribution = Data.aggregateProjection({
  years: 1,
  rate: 0,
  monthlyContribution: 100,
  taxOn: false
});
approx(simpleWithContribution.assets[12], 2200, "simple contribution adds to aggregate assets monthly");
approx(simpleWithContribution.debts[12], 3000, "simple contribution does not pay down aggregate debts");
assert.equal(simpleWithContribution.contribution.monthly, 100, "simple monthly contribution metadata is reported");
assert.equal(simpleWithContribution.contribution.total, 1200, "simple total contribution metadata is reported");

const simpleWithWithdrawal = Data.aggregateProjection({
  years: 1,
  rate: 0,
  monthlyContribution: -50,
  taxOn: false
});
approx(simpleWithWithdrawal.assets[12], 400, "negative simple monthly contribution withdraws from aggregate assets monthly");
assert.equal(simpleWithWithdrawal.contribution.monthly, -50, "negative simple monthly contribution metadata is reported");
assert.equal(simpleWithWithdrawal.contribution.total, -600, "negative simple total contribution metadata is reported");

const simpleContributionDisabled = Data.aggregateProjection({
  years: 1,
  rate: 0,
  monthlyContribution: 0,
  taxOn: false
});
approx(simpleContributionDisabled.assets[12], simple.assets[12], "disabled simple contribution keeps assets at no-contribution path");
assert.equal(simpleContributionDisabled.contribution.monthly, 0, "disabled simple contribution reports zero applied monthly");

assert.match(uiSource, /projectionView:\s*"simple"/, "simple projection is the no-history default view");
assert.match(uiSource, /projectionControlsOpen:\s*false/, "projection controls start collapsed without saved state");
assert.match(uiSource, /simpleMonthlyEnabled:\s*false/, "simple contribution starts disabled without saved amount");
assert.match(uiSource, /simpleMonthly:\s*\{\s*min:\s*-1000000/, "simple monthly contribution accepts negative values");
assert.match(uiSource, /: ui\.simpleMonthly > 0;/, "legacy nonzero simple monthly amount migrates to enabled");
const simpleMonthlyInputHandler = uiSource.match(/simpleMonthly\.addEventListener\("input", \(\) => \{([\s\S]*?)\n    \}\);/);
assert.ok(simpleMonthlyInputHandler, "simple monthly amount input handler exists");
assert.doesNotMatch(simpleMonthlyInputHandler[1], /ui\.simpleMonthlyEnabled\s*=/, "editing or clearing the simple monthly amount never flips the toggle");
assert.match(simpleMonthlyInputHandler[1], /raw === "-"/, "simple monthly input lets the user type a minus sign before digits");
assert.match(uiSource, /monthlyContribution:\s*effectiveSimpleMonthly\(\)/, "simple projection uses enabled-state effective monthly contribution");
assert.doesNotMatch(indexSource, /id="simple-monthly-input"[^>]*min="0"/, "simple monthly input markup does not forbid negatives");
assert.doesNotMatch(uiSource, /amtInput\.min = "0"/, "exact contribution inputs do not forbid negatives");
assert.match(uiSource, /function coerceProjectionView\(value\)[\s\S]*return value === "detailed" \|\| value === "simple" \? value : "simple";/, "invalid persisted projection view falls back to simple");
assert.match(uiSource, /function coerceProjectionControlsOpen\(value\)[\s\S]*return value === true;/, "invalid persisted projection controls state falls back to collapsed");
assert.ok(
  indexSource.indexOf('id="proj-view-simple"') < indexSource.indexOf('id="proj-view-detailed"'),
  "simple projection toggle appears before detailed"
);

console.log("ok - projection amortization and simple contribution smoke");
