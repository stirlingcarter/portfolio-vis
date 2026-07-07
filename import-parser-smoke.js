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

console.log(`ok - ${cases.length} import parser cases`);
