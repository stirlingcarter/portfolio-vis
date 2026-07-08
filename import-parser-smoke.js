const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const dataSource = fs.readFileSync(path.join(__dirname, "data.js"), "utf8");
const sandbox = {};
vm.runInNewContext(`${dataSource}\nglobalThis.Data = Data;`, sandbox, { filename: "data.js" });

const row = {
  "ID": 1,
  "Ticker": "QQQ",
  "Institution": "Robinhood",
  "Account Type": "Trad IRA",
  "Amount": 82,
  "Value": 39376.40,
  "Kind": "Asset",
  "Category": "Stock",
  "Subcategory": "Growth Stocks",
  "Nominal Rate": 0.08,
  "Nominal tax rate": 0.1,
  "Amort Months": "",
  "Amort Payment": ""
};
const json = JSON.stringify([row], null, 2);

const cases = [
  ["strict JSON", json],
  ["BOM and zero-width edges", `\uFEFF\u200B${json}\u200C`],
  ["surrounding single quotes", `'${json}'`],
  ["surrounding double quotes", `"${json}"`],
  ["surrounding smart quotes", `\u201C${json}\u201D`],
  ["leading apostrophe fragment", `'${json}`],
  ["markdown code fence", "```json\n" + json + "\n```"],
  ["surrounding message text", "Here is the exported portfolio:\n" + json + "\nImported from iMessage"],
  ["HTML text fallback", "<pre>" + json.replace(/"/g, "&quot;") + "</pre>"],
  ["URL text fragment", "https://example.invalid/import?text=" + encodeURIComponent(json)],
  ["JSON string wrapper", JSON.stringify(json)],
  ["single-quoted JSON-ish", json.replace(/"/g, "'")]
];

for (const [name, text] of cases) {
  const parsed = sandbox.Data.parseText(text);
  assert.equal(parsed.length, 1, name);
  assert.equal(parsed[0].Ticker, "QQQ", name);
  assert.equal(parsed[0]["Account Type"], "Trad IRA", name);
}

assert.throws(
  () => sandbox.Data.parseText("not a portfolio"),
  err => err.message.includes("Received") && err.message.includes("sanitized")
);

const specialRow = {
  ...row,
  "Institution": 'Brokerage, "Main"',
  "Category": "Stock|ETF",
  "Subcategory": "Growth\nStocks",
  "Nominal tax rate": "",
  "Amort Months": "",
  "Amort Payment": ""
};

sandbox.Data.loadArray([specialRow]);

const csv = sandbox.Data.toCSV();
assert.match(csv, /^ID,Ticker,Institution,Account Type,Amount,Value,Kind,Category,Subcategory,Nominal Rate,Nominal tax rate,Amort Months,Amort Payment\n/);
assert.match(csv, /"Brokerage, ""Main"""/, "CSV escapes commas and quotes");
assert.doesNotMatch(csv, /coldledger\.ui|theme|privacy|history/i, "CSV stays ledger-only");

const csvParsed = sandbox.Data.parseCSV(csv);
assert.equal(csvParsed.length, 1);
assert.equal(csvParsed[0].Institution, 'Brokerage, "Main"');
assert.equal(csvParsed[0].Category, "Stock|ETF");
assert.equal(csvParsed[0].Subcategory, "Growth\nStocks");
sandbox.Data.loadArray(csvParsed);
assert.equal(sandbox.Data.all()[0].Amount, 82, "CSV imports normalize numbers through Data.loadArray");
assert.equal(sandbox.Data.all()[0]["Nominal tax rate"], "", "CSV preserves blank optional tax");

const markdown = sandbox.Data.toMarkdown();
assert.match(markdown, /^# ColdData Ledger Export\n\n\| ID \| Ticker \|/);
assert.match(markdown, /Stock\\\|ETF/, "Markdown escapes pipe characters");
assert.match(markdown, /Growth<br>Stocks/, "Markdown keeps table rows single-line");
assert.doesNotMatch(markdown, /coldledger\.ui|theme|privacy|history/i, "Markdown stays ledger-only");

const markdownParsed = sandbox.Data.parseMarkdown(markdown);
assert.equal(markdownParsed.length, 1);
assert.equal(markdownParsed[0].Category, "Stock|ETF");
assert.equal(markdownParsed[0].Subcategory, "Growth\nStocks");

assert.throws(
  () => sandbox.Data.parseCSV('Ticker,Amount\n"QQQ,82'),
  /unterminated quoted CSV field/
);
assert.throws(
  () => sandbox.Data.parseMarkdown("not a ledger table"),
  /Markdown import expects a table/
);

console.log(`ok - ${cases.length} clipboard parser cases plus CSV/Markdown`);
