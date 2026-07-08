const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const stylesSource = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function extractCssRule(source, selector, startAt = 0) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)\\s*${escaped} \\{`, "g").exec(source.slice(startAt));
  assert.ok(match, `${selector} rule exists`);
  const start = startAt + match.index + match[0].search(/\S/);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not extract CSS rule ${selector}`);
}

function extractMediaBlock(query) {
  const start = stylesSource.indexOf(`@media ${query} {`);
  assert.notEqual(start, -1, `${query} media block exists`);
  const bodyStart = stylesSource.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < stylesSource.length; i++) {
    if (stylesSource[i] === "{") depth++;
    if (stylesSource[i] === "}") depth--;
    if (depth === 0) return stylesSource.slice(bodyStart + 1, i);
  }
  throw new Error(`could not extract media block ${query}`);
}

assert.match(indexSource, /id="history-chart"/, "history chart container exists");
assert.match(indexSource, /id="proj-chart"/, "projection chart container exists");
assert.match(indexSource, /id="ledger-table-wrap"/, "ledger table container exists");

const rootRule = extractCssRule(stylesSource, "html");
assert.match(rootRule, /overflow-x:\s*hidden/, "root clips document-level horizontal overflow");

const projectionRule = extractCssRule(stylesSource, "#proj-chart");
assert.match(projectionRule, /max-width:\s*100%/, "projection scroller stays within its card");
assert.match(projectionRule, /overflow-x:\s*auto/, "projection chart keeps internal horizontal scrolling");

const chartRule = extractCssRule(stylesSource, ".chart-svg");
assert.match(chartRule, /min-width:\s*760px/, "wide charts retain an intentional internal minimum width");

const tableRule = extractCssRule(stylesSource, ".table-scroll");
assert.match(tableRule, /max-width:\s*100%/, "ledger tables stay within their card shell");
assert.match(tableRule, /overflow-x:\s*auto/, "ledger tables keep internal horizontal scrolling");

const mobileBlock = extractMediaBlock("(max-width: 540px)");
const mobileHistoryRule = extractCssRule(mobileBlock, ".hero-history");
assert.match(mobileHistoryRule, /width:\s*100%/, "mobile history section no longer widens past the viewport");
assert.match(mobileHistoryRule, /max-width:\s*100%/, "mobile history section is capped to its card");
assert.doesNotMatch(mobileHistoryRule, /calc\(100%\s*\+/, "mobile history section does not add bleed width");

const mobileHistoryChartRule = extractCssRule(mobileBlock, ".history-chart");
assert.match(mobileHistoryChartRule, /margin-inline:\s*0/, "mobile history chart does not use negative inline margins");
assert.match(mobileHistoryChartRule, /overflow:\s*hidden/, "mobile history chart clips decorative SVG bleed");

const mobileHistorySvgRule = extractCssRule(mobileBlock, ".history-chart .chart-svg");
assert.match(mobileHistorySvgRule, /min-width:\s*0/, "mobile history SVG overrides the generic wide-chart minimum");
assert.match(mobileHistorySvgRule, /max-width:\s*100%/, "mobile history SVG fits the viewport");

console.log("ok - mobile overflow CSS smoke");
